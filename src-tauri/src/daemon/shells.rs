//! Interactive shells for terminal tabs and panels, kept running by the daemon.
//!
//! A window opens a shell by a key it chooses (its tab id). Opening a key that
//! already exists attaches to it instead: the window gets the recent output to
//! replay into xterm.js, then live output. Shells end only when a window closes
//! them or the program exits.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex, Weak},
};

use base64::Engine;
use serde_json::{json, Value};
use crate::pty::{Pty, PtyCommand, PtySize};

use super::{number, string, ConnId, Hub};

/// Recent output kept per shell, replayed to a window that attaches.
const SCROLLBACK_BYTES: usize = 2 * 1024 * 1024;

#[derive(Default)]
pub struct Shells {
    map: Mutex<HashMap<String, Arc<Shell>>>,
}

struct Shell {
    cwd: String,
    pty: Mutex<Option<Pty>>,
    inner: Mutex<ShellInner>,
}

#[derive(Default)]
struct ShellInner {
    scrollback: VecDeque<u8>,
    attached: HashSet<ConnId>,
    exited: bool,
}

fn encode(bytes: impl IntoIterator<Item = u8>) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes.into_iter().collect::<Vec<u8>>())
}

impl Shells {
    fn get(&self, key: &str) -> Result<Arc<Shell>, String> {
        self.map
            .lock()
            .map_err(|_| "Shell registry poisoned".to_owned())?
            .get(key)
            .cloned()
            .ok_or_else(|| "That shell is closed.".to_owned())
    }

    pub fn alive_count(&self) -> usize {
        self.map
            .lock()
            .map(|map| {
                map.values()
                    .filter(|shell| shell.inner.lock().is_ok_and(|inner| !inner.exited))
                    .count()
            })
            .unwrap_or(0)
    }

    pub fn list(&self) -> Value {
        let Ok(map) = self.map.lock() else { return Value::Array(Vec::new()) };
        Value::Array(
            map.iter()
                .map(|(key, shell)| {
                    let exited = shell.inner.lock().map(|inner| inner.exited).unwrap_or(true);
                    json!({ "key": key, "cwd": shell.cwd, "exited": exited })
                })
                .collect(),
        )
    }

    /// Attaches to the shell under `key`, or starts one in `cwd`.
    pub fn open(&self, hub: &Arc<Hub>, conn: ConnId, params: &Value) -> Result<Value, String> {
        let key = string(params, "key")?;
        let cols = number(params, "cols")? as u16;
        let rows = number(params, "rows")? as u16;

        if let Ok(shell) = self.get(&key) {
            let (scrollback, exited) = {
                let mut inner = shell.inner.lock().map_err(|_| "Shell poisoned")?;
                inner.attached.insert(conn);
                (encode(inner.scrollback.iter().copied()), inner.exited)
            };
            if !exited {
                if let Ok(pty) = shell.pty.lock() {
                    if let Some(pty) = pty.as_ref() {
                        // Full-screen programs redraw on a size change; nudge one even at the same size.
                        let _ = pty.resize(PtySize::new(cols, rows.saturating_sub(1).max(1)));
                        let _ = pty.resize(PtySize::new(cols, rows));
                    }
                }
            }
            return Ok(json!({ "created": false, "scrollback": scrollback, "exited": exited }));
        }

        let cwd = string(params, "cwd")?;
        let shell = Arc::new(Shell {
            cwd: cwd.clone(),
            pty: Mutex::new(None),
            inner: Mutex::new(ShellInner {
                attached: HashSet::from([conn]),
                ..ShellInner::default()
            }),
        });

        let output_shell: Weak<Shell> = Arc::downgrade(&shell);
        let output_hub = hub.clone();
        let output_key = key.clone();
        let exit_shell: Weak<Shell> = Arc::downgrade(&shell);
        let exit_hub = hub.clone();
        let exit_key = key.clone();

        let pty = Pty::spawn(
            PtyCommand {
                working_directory: Some(&cwd),
                ..PtyCommand::default()
            },
            PtySize::new(cols, rows),
            move |bytes| {
                let Some(shell) = output_shell.upgrade() else { return };
                let Ok(mut inner) = shell.inner.lock() else { return };
                inner.scrollback.extend(bytes);
                let excess = inner.scrollback.len().saturating_sub(SCROLLBACK_BYTES);
                inner.scrollback.drain(..excess);
                // Sent under the lock, so an attaching window can't miss or repeat a chunk.
                output_hub.event(
                    inner.attached.iter().copied(),
                    "shell.output",
                    json!({ "key": output_key, "data": encode(bytes.iter().copied()) }),
                );
            },
            move || {
                let Some(shell) = exit_shell.upgrade() else { return };
                let Ok(mut inner) = shell.inner.lock() else { return };
                inner.exited = true;
                exit_hub.event(inner.attached.iter().copied(), "shell.exit", json!({ "key": exit_key }));
            },
        )
        .map_err(|error| format!("Couldn't start a shell: {error}"))?;

        *shell.pty.lock().map_err(|_| "Shell poisoned")? = Some(pty);
        self.map.lock().map_err(|_| "Shell registry poisoned")?.insert(key, shell);
        Ok(json!({ "created": true, "scrollback": "", "exited": false }))
    }

    pub fn write(&self, key: &str, data: &str) -> Result<Value, String> {
        let shell = self.get(key)?;
        let pty = shell.pty.lock().map_err(|_| "Shell poisoned")?;
        let pty = pty.as_ref().ok_or("That shell is closed.")?;
        pty.write_owned(data.as_bytes().to_vec()).map_err(|error| error.to_string())?;
        Ok(Value::Null)
    }

    pub fn resize(&self, key: &str, cols: u16, rows: u16) -> Result<Value, String> {
        let shell = self.get(key)?;
        let pty = shell.pty.lock().map_err(|_| "Shell poisoned")?;
        let pty = pty.as_ref().ok_or("That shell is closed.")?;
        pty.resize(PtySize::new(cols, rows)).map_err(|error| error.to_string())?;
        Ok(Value::Null)
    }

    pub fn detach(&self, conn: ConnId, key: &str) {
        if let Ok(shell) = self.get(key) {
            if let Ok(mut inner) = shell.inner.lock() {
                inner.attached.remove(&conn);
            }
        }
    }

    pub fn detach_all(&self, conn: ConnId) {
        let Ok(map) = self.map.lock() else { return };
        for shell in map.values() {
            if let Ok(mut inner) = shell.inner.lock() {
                inner.attached.remove(&conn);
            }
        }
    }

    /// Dropping the PTY hangs up the shell.
    pub fn close(&self, key: &str) {
        let removed = self.map.lock().ok().and_then(|mut map| map.remove(key));
        if let Some(shell) = removed {
            if let Ok(mut pty) = shell.pty.lock() {
                pty.take();
            }
        }
    }

    pub fn close_all(&self) {
        let keys: Vec<String> = self
            .map
            .lock()
            .map(|map| map.keys().cloned().collect())
            .unwrap_or_default();
        for key in keys {
            self.close(&key);
        }
    }
}
