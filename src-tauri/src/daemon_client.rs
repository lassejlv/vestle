//! The app's connection to the background daemon (see `daemon`).
//!
//! The webview calls `daemon_request` with a method and params; daemon events
//! arrive as `daemon://event`. If the daemon isn't running it is started, and
//! if it's from another build it is restarted when nothing is running in it.

use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{unix::OwnedWriteHalf, UnixStream},
    sync::oneshot,
};

use crate::{
    daemon::{exe_mtime, PROTOCOL},
    paths,
};

type Reply = oneshot::Sender<Result<Value, String>>;

struct Connection {
    writer: tokio::sync::Mutex<OwnedWriteHalf>,
    waiting: Mutex<HashMap<u64, Reply>>,
    next_id: AtomicU64,
    open: AtomicBool,
}

impl Connection {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply, answer) = oneshot::channel();
        self.waiting
            .lock()
            .map_err(|_| "Daemon connection poisoned")?
            .insert(id, reply);
        let mut frame = json!({ "id": id, "method": method, "params": params }).to_string();
        frame.push('\n');
        let written = self.writer.lock().await.write_all(frame.as_bytes()).await;
        if let Err(error) = written {
            self.waiting.lock().ok().and_then(|mut waiting| waiting.remove(&id));
            return Err(format!("Lost the background service: {error}"));
        }
        answer
            .await
            .map_err(|_| "Lost the background service.".to_owned())?
    }
}

/// What the app knows about the daemon it's attached to.
#[derive(Default)]
struct Info {
    pid: u64,
    /// Started from an older build that was busy, so it was kept rather than restarted.
    stale: bool,
}

pub struct DaemonClient {
    app: AppHandle,
    connection: tokio::sync::Mutex<Option<Arc<Connection>>>,
    info: Mutex<Info>,
    /// Set after the first connection, so later ones are announced as reconnects.
    connected_before: AtomicBool,
}

impl DaemonClient {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            connection: tokio::sync::Mutex::new(None),
            info: Mutex::new(Info::default()),
            connected_before: AtomicBool::new(false),
        }
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.connection().await?.request(method, params).await
    }

    async fn connection(&self) -> Result<Arc<Connection>, String> {
        let mut current = self.connection.lock().await;
        if let Some(connection) = current.as_ref().filter(|connection| connection.open.load(Ordering::Relaxed)) {
            return Ok(connection.clone());
        }
        let connection = self.connect().await?;
        *current = Some(connection.clone());
        if self.connected_before.swap(true, Ordering::Relaxed) {
            let _ = self.app.emit("daemon://reconnected", ());
        }
        Ok(connection)
    }

    async fn connect(&self) -> Result<Arc<Connection>, String> {
        let connection = self.open_or_start().await?;
        let hello = connection
            .request("hello", json!({ "protocol": PROTOCOL }))
            .await?;
        let protocol = hello.get("protocol").and_then(Value::as_u64).unwrap_or(0);
        let same_build = hello.get("exeMtime").and_then(Value::as_u64) == Some(exe_mtime());
        let busy = hello.get("busy").and_then(Value::as_bool).unwrap_or(false);
        let pid = hello.get("pid").and_then(Value::as_u64).unwrap_or(0);

        if protocol == PROTOCOL && same_build {
            self.set_info(pid, false);
            return Ok(connection);
        }
        if protocol == PROTOCOL && busy {
            // A rebuilt app with work still running: keep the old daemon rather than kill that work.
            self.set_info(pid, true);
            return Ok(connection);
        }
        // Idle, or speaking another protocol: replace it with this build.
        let _ = connection.request("daemon.shutdown", Value::Null).await;
        for _ in 0..40 {
            if !connection.open.load(Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let connection = self.open_or_start().await?;
        let hello = connection.request("hello", json!({ "protocol": PROTOCOL })).await?;
        if hello.get("protocol").and_then(Value::as_u64) != Some(PROTOCOL) {
            return Err("The background service is from an incompatible version of Termy Code.".to_owned());
        }
        self.set_info(hello.get("pid").and_then(Value::as_u64).unwrap_or(0), false);
        Ok(connection)
    }

    fn set_info(&self, pid: u64, stale: bool) {
        if let Ok(mut info) = self.info.lock() {
            info.pid = pid;
            info.stale = stale;
        }
    }

    async fn open_or_start(&self) -> Result<Arc<Connection>, String> {
        let socket = paths::socket_path();
        if let Ok(stream) = UnixStream::connect(&socket).await {
            return Ok(self.attach(stream));
        }
        start_daemon()?;
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if let Ok(stream) = UnixStream::connect(&socket).await {
                return Ok(self.attach(stream));
            }
        }
        Err(format!(
            "Couldn't start the background service. See {}.",
            paths::daemon_log_file().display()
        ))
    }

    fn attach(&self, stream: UnixStream) -> Arc<Connection> {
        let (read, write) = stream.into_split();
        let connection = Arc::new(Connection {
            writer: tokio::sync::Mutex::new(write),
            waiting: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            open: AtomicBool::new(true),
        });
        let reader = connection.clone();
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(frame) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(id) = frame.get("id").and_then(Value::as_u64) {
                    let reply = reader.waiting.lock().ok().and_then(|mut waiting| waiting.remove(&id));
                    if let Some(reply) = reply {
                        let result = match frame.get("error") {
                            Some(error) => Err(error.as_str().unwrap_or("Background service error").to_owned()),
                            None => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = reply.send(result);
                    }
                } else if frame.get("event").is_some() {
                    let _ = app.emit("daemon://event", frame);
                }
            }
            reader.open.store(false, Ordering::Relaxed);
            if let Ok(mut waiting) = reader.waiting.lock() {
                waiting.clear();
            }
            let _ = app.emit("daemon://disconnected", ());
        });
        connection
    }
}

/// Starts `<this binary> --daemon` in its own process group, so it outlives the app
/// and doesn't get the terminal's Ctrl+C when the app runs under `tauri dev`.
fn start_daemon() -> Result<(), String> {
    use std::os::unix::process::CommandExt;

    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let log = paths::daemon_log_file();
    if let Some(parent) = log.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let stderr = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());
    std::process::Command::new(exe)
        .arg("--daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr)
        .process_group(0)
        .spawn()
        .map(drop)
        .map_err(|error| format!("Couldn't start the background service: {error}"))
}

#[tauri::command]
pub async fn daemon_request(client: State<'_, DaemonClient>, method: String, params: Value) -> Result<Value, String> {
    client.request(&method, params).await
}

/// `{ pid, stale }` for the Settings page, after making sure the daemon is reachable.
#[tauri::command]
pub async fn daemon_info(client: State<'_, DaemonClient>) -> Result<Value, String> {
    let status = client.request("status", Value::Null).await?;
    let stale = client.info.lock().map(|info| info.stale).unwrap_or(false);
    Ok(json!({
        "pid": status.get("pid"),
        "agents": status.get("agents"),
        "shells": status.get("shells"),
        "stale": stale,
    }))
}

/// Stops every background agent and shell, then starts a fresh daemon from this build.
#[tauri::command]
pub async fn daemon_restart(client: State<'_, DaemonClient>) -> Result<(), String> {
    let _ = client.request("daemon.shutdown", Value::Null).await;
    let mut current = client.connection.lock().await;
    if let Some(connection) = current.take() {
        for _ in 0..40 {
            if !connection.open.load(Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    drop(current);
    client.request("hello", json!({ "protocol": PROTOCOL })).await.map(drop)
}
