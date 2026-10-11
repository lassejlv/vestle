//! The background service that keeps agents and shells running when the app
//! is closed, like a terminal multiplexer.
//!
//! It is this same binary started with `--daemon`. The app connects over a
//! Unix socket and speaks newline-delimited JSON:
//!
//! - app → daemon: `{"id", "method", "params"}`, answered by `{"id", "result"}` or `{"id", "error"}`
//! - daemon → app: `{"event", "data"}`
//!
//! Closing the app only drops the connection. Agents keep working (the daemon
//! answers their file and terminal requests itself and logs everything they
//! report), shells keep running with their scrollback, and the next window
//! attaches to all of it again.

mod agents;
mod shells;

use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::{mpsc, Notify},
};

use crate::{agent_terminal::AgentTerminals, paths};

/// Bumped whenever the wire protocol changes, so an app never talks to an incompatible daemon.
pub const PROTOCOL: u64 = 1;

/// With no window, agent or shell for this long, the daemon exits.
const IDLE_EXIT: Duration = Duration::from_secs(10 * 60);

pub type ConnId = u64;

/// The connected windows, each fed through its own writer task.
#[derive(Default)]
pub struct Hub {
    conns: Mutex<HashMap<ConnId, mpsc::UnboundedSender<String>>>,
}

impl Hub {
    fn add(&self, conn: ConnId, sender: mpsc::UnboundedSender<String>) {
        if let Ok(mut conns) = self.conns.lock() {
            conns.insert(conn, sender);
        }
    }

    fn remove(&self, conn: ConnId) {
        if let Ok(mut conns) = self.conns.lock() {
            conns.remove(&conn);
        }
    }

    fn count(&self) -> usize {
        self.conns.lock().map(|conns| conns.len()).unwrap_or(0)
    }

    fn send(&self, conn: ConnId, frame: &Value) {
        if let Ok(conns) = self.conns.lock() {
            if let Some(sender) = conns.get(&conn) {
                let _ = sender.send(frame.to_string());
            }
        }
    }

    /// An event for some connections. Sending never blocks, so it's safe under other locks.
    pub fn event(&self, conns: impl IntoIterator<Item = ConnId>, name: &str, data: Value) {
        let frame = json!({ "event": name, "data": data }).to_string();
        if let Ok(all) = self.conns.lock() {
            for conn in conns {
                if let Some(sender) = all.get(&conn) {
                    let _ = sender.send(frame.clone());
                }
            }
        }
    }

    pub fn broadcast(&self, name: &str, data: Value) {
        let conns: Vec<ConnId> = self
            .conns
            .lock()
            .map(|conns| conns.keys().copied().collect())
            .unwrap_or_default();
        self.event(conns, name, data);
    }
}

pub struct Daemon {
    pub hub: Arc<Hub>,
    agents: agents::Agents,
    shells: shells::Shells,
    pub terminals: AgentTerminals,
    next_conn: AtomicU64,
    /// The binary's modification time when the daemon started, so a rebuilt app can tell it's stale.
    exe_mtime: u64,
    shutdown: Notify,
}

impl Daemon {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            hub: Arc::new(Hub::default()),
            agents: agents::Agents::recover(&paths::agent_log_dir()),
            shells: shells::Shells::default(),
            terminals: AgentTerminals::default(),
            next_conn: AtomicU64::new(1),
            exe_mtime: exe_mtime(),
            shutdown: Notify::new(),
        })
    }
}

/// Seconds since the epoch the running executable was last modified.
pub fn exe_mtime() -> u64 {
    std::env::current_exe()
        .and_then(std::fs::metadata)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|age| age.as_secs())
        .unwrap_or(0)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Runs the daemon until it is told to stop or sits idle. Exits the process.
pub fn run() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("daemon runtime");
    let code = runtime.block_on(serve());
    // Agents and shells are dropped with the runtime, which kills them.
    drop(runtime);
    std::process::exit(code);
}

async fn serve() -> i32 {
    let socket = paths::socket_path();
    if UnixStream::connect(&socket).await.is_ok() {
        eprintln!("termy daemon: already running at {}", socket.display());
        return 0;
    }
    if let Some(parent) = socket.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::remove_file(&socket);
    let listener = match UnixListener::bind(&socket) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("termy daemon: couldn't listen on {}: {error}", socket.display());
            return 1;
        }
    };
    restrict_to_user(&socket);

    let daemon = Daemon::new();
    eprintln!("termy daemon: listening on {} (pid {})", socket.display(), std::process::id());

    let idle = tokio::spawn(watch_idle(daemon.clone()));
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    tokio::spawn(connection(daemon.clone(), stream));
                }
                Err(error) => eprintln!("termy daemon: accept failed: {error}"),
            },
            _ = daemon.shutdown.notified() => break,
        }
    }
    idle.abort();
    daemon.agents.kill_all(&daemon);
    daemon.shells.close_all();
    let _ = std::fs::remove_file(&socket);
    eprintln!("termy daemon: stopped");
    0
}

#[cfg(unix)]
fn restrict_to_user(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

async fn watch_idle(daemon: Arc<Daemon>) {
    let mut idle_since: Option<Instant> = None;
    loop {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let busy = daemon.hub.count() > 0 || daemon.agents.alive_count() > 0 || daemon.shells.alive_count() > 0;
        if busy {
            idle_since = None;
            continue;
        }
        let since = *idle_since.get_or_insert_with(Instant::now);
        if since.elapsed() >= IDLE_EXIT {
            eprintln!("termy daemon: idle, exiting");
            daemon.shutdown.notify_one();
            return;
        }
    }
}

async fn connection(daemon: Arc<Daemon>, stream: UnixStream) {
    let conn = daemon.next_conn.fetch_add(1, Ordering::Relaxed);
    let (read, mut write) = stream.into_split();
    let (sender, mut outbox) = mpsc::unbounded_channel::<String>();
    daemon.hub.add(conn, sender);

    let writer = tokio::spawn(async move {
        while let Some(mut frame) = outbox.recv().await {
            frame.push('\n');
            if write.write_all(frame.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    // Requests from one window run in order, so its writes to an agent or shell stay in order.
    let mut lines = BufReader::new(read).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(frame) = serde_json::from_str::<Value>(&line) else { continue };
        let id = frame.get("id").cloned().unwrap_or(Value::Null);
        let method = frame.get("method").and_then(Value::as_str).unwrap_or_default().to_owned();
        let params = frame.get("params").cloned().unwrap_or(Value::Null);
        let reply = match dispatch(&daemon, conn, &method, params).await {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(error) => json!({ "id": id, "error": error }),
        };
        daemon.hub.send(conn, &reply);
    }

    daemon.hub.remove(conn);
    daemon.agents.detach_all(conn);
    daemon.shells.detach_all(conn);
    writer.abort();
}

fn param<'a>(params: &'a Value, name: &str) -> Result<&'a Value, String> {
    params.get(name).ok_or_else(|| format!("Missing `{name}`"))
}

fn string(params: &Value, name: &str) -> Result<String, String> {
    param(params, name)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("`{name}` must be a string"))
}

fn number(params: &Value, name: &str) -> Result<u64, String> {
    param(params, name)?
        .as_u64()
        .ok_or_else(|| format!("`{name}` must be a number"))
}

async fn dispatch(daemon: &Arc<Daemon>, conn: ConnId, method: &str, params: Value) -> Result<Value, String> {
    match method {
        "hello" => Ok(json!({
            "protocol": PROTOCOL,
            "version": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
            "exeMtime": daemon.exe_mtime,
            "busy": daemon.agents.alive_count() > 0 || daemon.shells.alive_count() > 0,
        })),
        "status" => Ok(json!({
            "agents": daemon.agents.alive_count(),
            "shells": daemon.shells.alive_count(),
            "pid": std::process::id(),
        })),
        "daemon.shutdown" => {
            daemon.shutdown.notify_one();
            Ok(Value::Null)
        }
        "agent.list" => Ok(daemon.agents.list()),
        "agent.spawn" => daemon.spawn_agent(&params).await,
        "agent.attach" => daemon.agents.attach(conn, &string(&params, "key")?, number(&params, "after")?),
        "agent.detach" => {
            daemon.agents.detach(conn, &string(&params, "key")?);
            Ok(Value::Null)
        }
        "agent.send" => daemon.send_to_agent(conn, &string(&params, "key")?, param(&params, "message")?.clone()).await,
        "agent.ack" => {
            daemon.agents.ack(&string(&params, "key")?, number(&params, "seq")?);
            Ok(Value::Null)
        }
        "agent.kill" => {
            daemon.kill_agent(&string(&params, "key")?);
            Ok(Value::Null)
        }
        "terminals.snapshot" => Ok(Value::Array(daemon.terminals.snapshot())),
        "shell.list" => Ok(daemon.shells.list()),
        "shell.open" => daemon.shells.open(&daemon.hub, conn, &params),
        "shell.write" => daemon.shells.write(&string(&params, "key")?, &string(&params, "data")?),
        "shell.resize" => daemon.shells.resize(
            &string(&params, "key")?,
            number(&params, "cols")? as u16,
            number(&params, "rows")? as u16,
        ),
        "shell.detach" => {
            daemon.shells.detach(conn, &string(&params, "key")?);
            Ok(Value::Null)
        }
        "shell.close" => {
            daemon.shells.close(&string(&params, "key")?);
            Ok(Value::Null)
        }
        other => Err(format!("Unknown method `{other}`")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Speaks just enough ACP: a prompt reports an update, reads a file through the
    /// client, asks for permission, reports the answer and ends the turn.
    const FAKE_AGENT: &str = r#"
import sys, json
def send(m):
    sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
def read():
    return json.loads(sys.stdin.readline())
path = sys.argv[1]
for line in sys.stdin:
    m = json.loads(line)
    if m.get("method") == "initialize":
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"protocolVersion": 1}})
    elif m.get("method") == "session/prompt":
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {"step": 1}}})
        send({"jsonrpc": "2.0", "id": "read", "method": "fs/read_text_file", "params": {"sessionId": "s", "path": path}})
        content = read()["result"]["content"]
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {"file": content}}})
        send({"jsonrpc": "2.0", "id": "ask", "method": "session/request_permission", "params": {"sessionId": "s"}})
        answer = read()["result"]
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {"answer": answer}}})
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"stopReason": "end_turn"}})
"#;

    async fn next_event(inbox: &mut mpsc::UnboundedReceiver<String>, name: &str) -> Value {
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(5), inbox.recv())
                .await
                .expect("timed out waiting for an event")
                .expect("hub closed");
            let frame: Value = serde_json::from_str(&frame).unwrap();
            if frame["event"] == name {
                return frame["data"].clone();
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn agent_keeps_working_without_a_window_and_replays_to_the_next_one() {
        let dir = std::env::temp_dir().join(format!("termy-daemon-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("TERMY_DATA_DIR", &dir);
        let file = dir.join("notes.txt");
        std::fs::write(&file, "hello from disk").unwrap();

        let daemon = Daemon::new();
        let (first, mut first_inbox) = mpsc::unbounded_channel();
        daemon.hub.add(1, first);

        let spawn = json!({
            "key": "thread-1",
            "command": "python3",
            "args": ["-c", FAKE_AGENT, file.to_str().unwrap()],
            "cwd": dir.to_str().unwrap(),
        });
        dispatch(&daemon, 1, "agent.spawn", spawn).await.unwrap();
        dispatch(&daemon, 1, "agent.attach", json!({ "key": "thread-1", "after": 0 })).await.unwrap();

        let send = |id: u64, method: &str| {
            json!({ "key": "thread-1", "message": { "jsonrpc": "2.0", "id": id, "method": method, "params": { "sessionId": "s" } } })
        };
        dispatch(&daemon, 1, "agent.send", send(1, "initialize")).await.unwrap();
        let reply = next_event(&mut first_inbox, "agent.message").await;
        assert_eq!(reply["message"]["id"], 1, "the window gets its own id back");

        dispatch(&daemon, 1, "agent.send", send(1, "session/prompt")).await.unwrap();
        let ask = next_event(&mut first_inbox, "agent.message").await;
        assert_eq!(ask["message"]["method"], "session/request_permission");

        // The window goes away mid-turn, with the agent blocked on a permission prompt.
        daemon.hub.remove(1);
        daemon.agents.detach_all(1);
        let listed = dispatch(&daemon, 2, "agent.list", Value::Null).await.unwrap();
        assert!(listed[0]["turn"].is_object(), "the turn is still running");

        let (second, mut second_inbox) = mpsc::unbounded_channel();
        daemon.hub.add(2, second);
        let attached = dispatch(&daemon, 2, "agent.attach", json!({ "key": "thread-1", "after": 0 })).await.unwrap();
        let updates: Vec<&Value> = attached["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| &entry["message"]["params"]["update"])
            .collect();
        assert_eq!(updates[0]["step"], 1);
        assert_eq!(updates[1]["file"], "hello from disk", "the daemon answered fs/read_text_file");
        assert_eq!(attached["pending"][0]["method"], "session/request_permission");
        assert_eq!(attached["initialize"]["protocolVersion"], 1);

        let answer = json!({
            "key": "thread-1",
            "message": { "jsonrpc": "2.0", "id": "ask", "result": { "outcome": "allowed" } },
        });
        dispatch(&daemon, 2, "agent.send", answer).await.unwrap();
        let answered = next_event(&mut second_inbox, "agent.entry").await;
        assert_eq!(answered["entry"]["message"]["params"]["update"]["answer"]["outcome"], "allowed");
        let ended = next_event(&mut second_inbox, "agent.entry").await;
        assert_eq!(ended["entry"]["message"]["method"], "_termy/turn_end");
        assert_eq!(ended["entry"]["message"]["params"]["stopReason"], "end_turn");

        let listed = dispatch(&daemon, 2, "agent.list", Value::Null).await.unwrap();
        assert!(listed[0]["turn"].is_null());
        assert_eq!(listed[0]["lastSeq"], 4);

        daemon.kill_agent("thread-1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_shell_keeps_its_output_for_the_next_window() {
        use base64::Engine;
        let decode = |data: &Value| {
            String::from_utf8_lossy(&base64::engine::general_purpose::STANDARD.decode(data.as_str().unwrap()).unwrap())
                .into_owned()
        };
        let daemon = Daemon::new();
        let (first, mut first_inbox) = mpsc::unbounded_channel();
        daemon.hub.add(1, first);
        let open = json!({ "key": "tab-1", "cwd": std::env::temp_dir(), "cols": 80, "rows": 24 });
        let opened = dispatch(&daemon, 1, "shell.open", open.clone()).await.unwrap();
        assert_eq!(opened["created"], true);
        dispatch(&daemon, 1, "shell.write", json!({ "key": "tab-1", "data": "echo multiplexed-$((6*7))\n" }))
            .await
            .unwrap();
        let mut seen = String::new();
        while !seen.contains("multiplexed-42") {
            seen += &decode(&next_event(&mut first_inbox, "shell.output").await["data"]);
        }

        daemon.hub.remove(1);
        daemon.shells.detach_all(1);
        let (second, _second_inbox) = mpsc::unbounded_channel();
        daemon.hub.add(2, second);
        let reopened = dispatch(&daemon, 2, "shell.open", open).await.unwrap();
        assert_eq!(reopened["created"], false, "the same shell, not a new one");
        assert!(decode(&reopened["scrollback"]).contains("multiplexed-42"));
        assert_eq!(daemon.shells.alive_count(), 1);

        dispatch(&daemon, 2, "shell.close", json!({ "key": "tab-1" })).await.unwrap();
        assert_eq!(daemon.shells.alive_count(), 0);
    }
}
