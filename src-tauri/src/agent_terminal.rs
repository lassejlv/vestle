//! ACP `terminal/*` requests: commands the agent runs through the client.
//! Each command gets its own Alacritty PTY. Output is kept as plain text (escape
//! sequences removed, carriage returns applied) because it goes back to a
//! model, and is also streamed to the webview for the live step.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::pty::{Pty, PtyCommand, PtySize, TerminalLaunch};
use tokio::sync::watch;

use crate::shell_env;

/// Agents read output back as text, so a wide PTY avoids hard wraps.
const COLS: u16 = 200;
const ROWS: u16 = 50;
const DEFAULT_OUTPUT_LIMIT: usize = 1024 * 1024;

/// Where live output and exits go: `(event, data)`, e.g. to every attached window.
pub type Sink = Arc<dyn Fn(&str, Value) + Send + Sync>;

#[derive(Default)]
pub struct AgentTerminals {
    next_id: AtomicU32,
    open: Mutex<HashMap<String, Arc<AgentTerminal>>>,
}

struct AgentTerminal {
    /// The agent that created it; its terminals go when it does.
    owner: String,
    pty: Mutex<Option<Pty>>,
    /// Shared with the PTY reader thread, which appends to it.
    output: Arc<Mutex<Output>>,
    exited: watch::Receiver<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVariable {
    name: String,
    value: String,
}

/// ACP `terminal/create` params (the session id is ignored).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: Vec<EnvVariable>,
    cwd: Option<String>,
    output_byte_limit: Option<usize>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitStatus {
    exit_code: Option<i32>,
    signal: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputResponse {
    output: String,
    truncated: bool,
    exit_status: Option<ExitStatus>,
}

fn signal_name(signal: i32) -> String {
    match signal {
        1 => "SIGHUP".into(),
        2 => "SIGINT".into(),
        3 => "SIGQUIT".into(),
        6 => "SIGABRT".into(),
        9 => "SIGKILL".into(),
        13 => "SIGPIPE".into(),
        15 => "SIGTERM".into(),
        other => format!("SIG{other}"),
    }
}

impl AgentTerminal {
    fn exit_status(&self) -> Option<ExitStatus> {
        let pty = self.pty.lock().ok()?;
        let status = pty.as_ref()?.exit_status()?;
        Some(ExitStatus {
            exit_code: status.code,
            signal: status.signal.map(signal_name),
        })
    }
}

impl AgentTerminals {
    fn get(&self, id: &str) -> Result<Arc<AgentTerminal>, String> {
        self.open
            .lock()
            .map_err(|_| "Terminal registry poisoned".to_owned())?
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Unknown terminal {id}"))
    }

    /// ACP `terminal/create`. Output streams to `sink` as `acpTerminal.output` / `acpTerminal.exit`.
    pub fn create(&self, owner: &str, request: CreateRequest, sink: Sink) -> Result<String, String> {
        let id = format!("term-{}", self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        // A bare command line (no separate args) runs through the shell, like the agent expects.
        let launch = if request.args.is_empty() && request.command.contains(char::is_whitespace) {
            TerminalLaunch::ShellCommand(request.command.clone())
        } else {
            TerminalLaunch::Program {
                program: request.command.clone(),
                args: request.args.clone(),
            }
        };
        let mut environment = vec![
            ("PATH".to_owned(), shell_env::login_path().to_owned()),
            // Most tools respect these and skip pagers and colour, which keeps output readable.
            ("PAGER".to_owned(), "cat".to_owned()),
            ("GIT_PAGER".to_owned(), "cat".to_owned()),
        ];
        environment.extend(request.env.into_iter().map(|variable| (variable.name, variable.value)));

        let output = Arc::new(Mutex::new(Output::new(
            request.output_byte_limit.unwrap_or(DEFAULT_OUTPUT_LIMIT),
        )));
        let (exited_tx, exited_rx) = watch::channel(false);
        let terminal = Arc::new(AgentTerminal {
            owner: owner.to_owned(),
            pty: Mutex::new(None),
            output: output.clone(),
            exited: exited_rx,
        });

        let sink_output = output;
        let stream_sink = sink.clone();
        let stream_id = id.clone();
        let mut sanitizer = Sanitizer::default();
        let exit_id = id.clone();
        let exit_terminal = Arc::downgrade(&terminal);

        let pty = Pty::spawn(
            PtyCommand {
                launch: Some(&launch),
                working_directory: request.cwd.as_deref(),
                environment: &environment,
                ..PtyCommand::default()
            },
            PtySize::new(COLS, ROWS),
            move |bytes| {
                let text = sanitizer.feed(bytes);
                if text.is_empty() {
                    return;
                }
                if let Ok(mut output) = sink_output.lock() {
                    output.push(&text);
                }
                stream_sink("acpTerminal.output", json!({ "id": stream_id, "text": text }));
            },
            move || {
                let _ = exited_tx.send(true);
                if let Some(status) = exit_terminal.upgrade().and_then(|terminal| terminal.exit_status()) {
                    sink("acpTerminal.exit", json!({ "id": exit_id, "exitStatus": status }));
                }
            },
        )
        .map_err(|error| format!("Couldn't run `{}`: {error}", request.command))?;

        *terminal.pty.lock().map_err(|_| "Terminal poisoned")? = Some(pty);
        self.open
            .lock()
            .map_err(|_| "Terminal registry poisoned")?
            .insert(id.clone(), terminal);
        Ok(id)
    }

    /// ACP `terminal/output`.
    pub fn output(&self, id: &str) -> Result<OutputResponse, String> {
        let terminal = self.get(id)?;
        let (output, truncated) = terminal.output.lock().map_err(|_| "Terminal poisoned")?.snapshot();
        Ok(OutputResponse {
            output,
            truncated,
            exit_status: terminal.exit_status(),
        })
    }

    /// ACP `terminal/wait_for_exit`.
    pub async fn wait(&self, id: &str) -> Result<ExitStatus, String> {
        let terminal = self.get(id)?;
        let mut exited = terminal.exited.clone();
        exited
            .wait_for(|exited| *exited)
            .await
            .map_err(|_| "Terminal was released".to_owned())?;
        Ok(terminal.exit_status().unwrap_or(ExitStatus {
            exit_code: None,
            signal: None,
        }))
    }

    /// ACP `terminal/kill`: stops the command but keeps its output readable.
    pub fn kill(&self, id: &str) -> Result<(), String> {
        let terminal = self.get(id)?;
        let pty = terminal.pty.lock().map_err(|_| "Terminal poisoned")?;
        match pty.as_ref() {
            Some(pty) => pty.kill().map_err(|error| error.to_string()),
            None => Ok(()),
        }
    }

    /// ACP `terminal/release`: drops the PTY, which hangs up anything still running.
    pub fn release(&self, id: &str) -> Result<(), String> {
        let removed = self
            .open
            .lock()
            .map_err(|_| "Terminal registry poisoned")?
            .remove(id);
        if let Some(terminal) = removed {
            if let Ok(mut pty) = terminal.pty.lock() {
                pty.take();
            }
        }
        Ok(())
    }

    /// Releases every terminal an agent created, when the agent exits or is stopped.
    pub fn release_owned_by(&self, owner: &str) {
        let ids: Vec<String> = match self.open.lock() {
            Ok(open) => open
                .iter()
                .filter(|(_, terminal)| terminal.owner == owner)
                .map(|(id, _)| id.clone())
                .collect(),
            Err(_) => return,
        };
        for id in ids {
            let _ = self.release(&id);
        }
    }

    /// Every open terminal's output so far, for a window that just attached.
    pub fn snapshot(&self) -> Vec<Value> {
        let Ok(open) = self.open.lock() else { return Vec::new() };
        open.iter()
            .filter_map(|(id, terminal)| {
                let (text, _) = terminal.output.lock().ok()?.snapshot();
                Some(json!({ "id": id, "text": text, "exitStatus": terminal.exit_status() }))
            })
            .collect()
    }
}

// ── output ───────────────────────────────────────────────────────────────

/// Text output with ACP's byte limit: once over it, the oldest text is dropped.
///
/// Carriage returns behave like a terminal's: the cursor goes back to the
/// start of the line and later characters overwrite it (progress bars).
struct Output {
    committed: String,
    line: Vec<char>,
    column: usize,
    limit: usize,
    truncated: bool,
}

impl Output {
    fn new(limit: usize) -> Self {
        Self {
            committed: String::new(),
            line: Vec::new(),
            column: 0,
            limit,
            truncated: false,
        }
    }

    fn push(&mut self, chunk: &str) {
        for character in chunk.chars() {
            match character {
                '\r' => self.column = 0,
                '\n' => {
                    self.committed.extend(self.line.drain(..));
                    self.committed.push('\n');
                    self.column = 0;
                }
                other => {
                    if self.column < self.line.len() {
                        self.line[self.column] = other;
                    } else {
                        self.line.push(other);
                    }
                    self.column += 1;
                }
            }
        }
        let line_bytes: usize = self.line.iter().map(|character| character.len_utf8()).sum();
        let total = self.committed.len() + line_bytes;
        if total > self.limit {
            let mut cut = (total - self.limit).min(self.committed.len());
            while !self.committed.is_char_boundary(cut) {
                cut += 1;
            }
            self.committed.drain(..cut);
            self.truncated = true;
        }
    }

    fn snapshot(&self) -> (String, bool) {
        let mut text = self.committed.clone();
        text.extend(self.line.iter());
        (text, self.truncated)
    }
}

/// Strips terminal escape sequences from a PTY byte stream, across chunk
/// boundaries, and decodes UTF-8 without splitting characters.
#[derive(Default)]
struct Sanitizer {
    state: EscapeState,
    pending_utf8: Vec<u8>,
}

#[derive(Default, Clone, Copy, PartialEq)]
enum EscapeState {
    #[default]
    Ground,
    Escape,
    Csi,
    /// OSC, DCS, APC, PM and SOS: everything up to BEL or ST.
    String,
    StringEscape,
    /// `ESC (` and friends take one more byte.
    Charset,
}

impl Sanitizer {
    fn feed(&mut self, bytes: &[u8]) -> String {
        let mut plain = std::mem::take(&mut self.pending_utf8);
        for &byte in bytes {
            use EscapeState::*;
            self.state = match (self.state, byte) {
                (Ground, 0x1b) => Escape,
                (Ground, b'\n' | b'\t') => {
                    plain.push(byte);
                    Ground
                }
                (Ground, b'\r') => {
                    plain.push(b'\r');
                    Ground
                }
                // Other C0 controls (bell, backspace, ...) carry no text.
                (Ground, 0x00..=0x1f | 0x7f) => Ground,
                (Ground, _) => {
                    plain.push(byte);
                    Ground
                }
                (Escape, b'[') => Csi,
                (Escape, b']' | b'P' | b'_' | b'^' | b'X') => String,
                (Escape, b'(' | b')' | b'*' | b'+' | b'#' | b'%') => Charset,
                (Escape, _) => Ground,
                (Charset, _) => Ground,
                (Csi, 0x40..=0x7e) => Ground,
                (Csi, _) => Csi,
                (String, 0x07) => Ground,
                (String, 0x1b) => StringEscape,
                (String, _) => String,
                (StringEscape, b'\\') => Ground,
                (StringEscape, _) => String,
            };
        }

        let valid = match std::str::from_utf8(&plain) {
            Ok(_) => plain.len(),
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(_) => return String::from_utf8_lossy(&plain).into_owned(),
        };
        self.pending_utf8 = plain.split_off(valid);
        String::from_utf8(plain).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_escapes_across_chunks() {
        let mut sanitizer = Sanitizer::default();
        let mut text = sanitizer.feed(b"\x1b[1;32mok\x1b[");
        text += &sanitizer.feed(b"0m done\x1b]0;title\x07\r\nnext");
        assert_eq!(text, "ok done\r\nnext");
    }

    #[test]
    fn runs_a_shell_command_and_reports_clean_output_and_exit_code() {
        let (exit_tx, exit_rx) = std::sync::mpsc::channel();
        let output = Arc::new(Mutex::new(Output::new(DEFAULT_OUTPUT_LIMIT)));
        let sink = output.clone();
        let mut sanitizer = Sanitizer::default();
        let launch = TerminalLaunch::ShellCommand(
            "printf '\\033[32mbuilding\\033[0m\\r\\n10%%\\r100%%\\n'; echo \"$TERMY_AGENT\"; exit 3".to_owned(),
        );
        let environment = [("TERMY_AGENT".to_owned(), "codex".to_owned())];
        let pty = Pty::spawn(
            PtyCommand {
                launch: Some(&launch),
                environment: &environment,
                ..PtyCommand::default()
            },
            PtySize::new(COLS, ROWS),
            move |bytes| {
                let text = sanitizer.feed(bytes);
                sink.lock().unwrap().push(&text);
            },
            move || {
                let _ = exit_tx.send(());
            },
        )
        .expect("command should start");
        exit_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("command should exit");
        // The reader may still be flushing the final chunk when the exit callback fires.
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert_eq!(output.lock().unwrap().snapshot().0, "building\n100%\ncodex\n");
        assert_eq!(pty.exit_status().and_then(|status| status.code), Some(3));
    }

    #[test]
    fn keeps_split_utf8_characters_whole() {
        let mut sanitizer = Sanitizer::default();
        let bytes = "ø".as_bytes();
        let first = sanitizer.feed(&bytes[..1]);
        let second = sanitizer.feed(&bytes[1..]);
        assert_eq!(format!("{first}{second}"), "ø");
    }

    #[test]
    fn carriage_return_overwrites_and_limit_drops_oldest() {
        let mut output = Output::new(12);
        output.push("10%\r50%\r100%\r\r\nab");
        assert_eq!(output.snapshot(), ("100%\nab".to_owned(), false));
        output.push("cdefgh");
        assert_eq!(output.snapshot(), ("00%\nabcdefgh".to_owned(), true));
    }
}
