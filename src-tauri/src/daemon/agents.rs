//! Agents owned by the daemon, keyed by the thread they belong to.
//!
//! The daemon sits between the window's ACP client and the agent process and
//! rewrites just enough JSON-RPC to let windows come and go:
//!
//! - Requests from a window get daemon-wide ids, so a new window's ids never
//!   collide with an earlier window's requests that are still in flight. Responses
//!   go back to the window that asked, under its own id.
//! - `fs/*` and `terminal/*` requests from the agent are answered here, so an
//!   agent keeps working with no window open.
//! - Other agent requests (permission prompts, questions) wait for a window and
//!   are handed to every window that attaches until one answers.
//! - Notifications are numbered and written to a log on disk. A window attaches
//!   with the last number it saved and gets everything after it. Notifications
//!   that arrive during `session/load` are marked `replay`, since they repeat
//!   history the window already has.
//! - The end of every `session/prompt` is logged as a `_termy/turn_end`
//!   notification, so a turn that finished while no window watched still ends
//!   in the thread.
//! - The newest session-level update of each kind (commands, mode, config,
//!   usage, title) is kept apart from the log, including mode and config changes
//!   a window made itself, so a window attaching after the log was trimmed still
//!   shows the session as it is.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    sync::oneshot,
};

use super::{now_ms, param, string, ConnId, Daemon};
use crate::{agent_terminal::CreateRequest, paths, shell_env, workspace};

const STDERR_LINES: usize = 20;
const TURN_END: &str = "_termy/turn_end";

/// Updates that set session state rather than add to the timeline; only the newest of each counts.
const STATE_UPDATES: &[&str] = &[
    "available_commands_update",
    "config_option_update",
    "current_mode_update",
    "usage_update",
    "session_info_update",
];

pub struct Agents {
    map: Mutex<HashMap<String, Arc<Agent>>>,
}

pub struct Agent {
    key: String,
    cwd: String,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    kill: Mutex<Option<oneshot::Sender<()>>>,
    state: Mutex<AgentState>,
}

struct Outgoing {
    conn: ConnId,
    client_id: Value,
    method: String,
    session_id: Option<String>,
    /// For `session/set_mode`, the mode being switched to.
    mode_id: Option<String>,
}

struct AgentState {
    next_id: u64,
    outgoing: HashMap<u64, Outgoing>,
    /// Agent requests a window has to answer, as received.
    pending: Vec<Value>,
    log: AgentLog,
    /// The prompt in flight: `{ sessionId, startedAt }`.
    turn: Option<Value>,
    initialize: Option<Value>,
    session: Option<Value>,
    session_id: Option<String>,
    /// The newest state update of each kind, as `session/update` notifications.
    latest: HashMap<String, Value>,
    /// `session/load` requests in flight; their notifications are replays.
    loads: u32,
    /// `Some` once the process is gone, with its exit code if it had one.
    exited: Option<Option<i32>>,
    stderr: VecDeque<String>,
    attached: HashSet<ConnId>,
}

impl AgentState {
    fn new(log: AgentLog) -> Self {
        Self {
            next_id: 1,
            outgoing: HashMap::new(),
            pending: Vec::new(),
            log,
            turn: None,
            initialize: None,
            session: None,
            session_id: None,
            latest: HashMap::new(),
            loads: 0,
            exited: None,
            stderr: VecDeque::new(),
            attached: HashSet::new(),
        }
    }

    fn summary(&self, key: &str, cwd: &str) -> Value {
        json!({
            "key": key,
            "cwd": cwd,
            "alive": self.exited.is_none(),
            "exitCode": self.exited.flatten(),
            "stderr": self.stderr.iter().cloned().collect::<Vec<_>>().join("\n"),
            "turn": self.turn,
            "initialize": self.initialize,
            "session": self.session,
            "sessionId": self.session_id,
            "lastSeq": self.log.next_seq - 1,
        })
    }

    fn remember_state(&mut self, session_id: Option<&str>, update: Value) {
        let Some(kind) = update.get("sessionUpdate").and_then(Value::as_str) else { return };
        if !STATE_UPDATES.contains(&kind) {
            return;
        }
        let message = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": { "sessionId": session_id, "update": update },
        });
        self.latest.insert(kind.to_owned(), message);
    }
}

/// Numbered notifications, mirrored to `<key>.ndjson` so they survive a daemon restart.
struct AgentLog {
    path: PathBuf,
    entries: Vec<Value>,
    next_seq: u64,
}

impl AgentLog {
    fn fresh(path: PathBuf) -> Self {
        let _ = fs::remove_file(&path);
        Self {
            path,
            entries: Vec::new(),
            next_seq: 1,
        }
    }

    fn recover(path: PathBuf) -> Self {
        let entries: Vec<Value> = fs::read_to_string(&path)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        let next_seq = entries
            .iter()
            .filter_map(|entry| entry.get("seq").and_then(Value::as_u64))
            .max()
            .unwrap_or(0)
            + 1;
        Self { path, entries, next_seq }
    }

    fn append(&mut self, replay: bool, message: Value) -> Value {
        let entry = json!({ "seq": self.next_seq, "replay": replay, "message": message });
        self.next_seq += 1;
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&self.path) {
            let _ = writeln!(file, "{entry}");
        }
        self.entries.push(entry.clone());
        entry
    }

    fn after(&self, seq: u64) -> Vec<Value> {
        self.entries
            .iter()
            .filter(|entry| entry.get("seq").and_then(Value::as_u64).is_some_and(|entry_seq| entry_seq > seq))
            .cloned()
            .collect()
    }

    /// The window saved everything up to `seq`, so those entries can go.
    fn ack(&mut self, seq: u64) {
        let before = self.entries.len();
        self.entries
            .retain(|entry| entry.get("seq").and_then(Value::as_u64).is_some_and(|entry_seq| entry_seq > seq));
        if self.entries.len() == before {
            return;
        }
        if self.entries.is_empty() {
            let _ = fs::remove_file(&self.path);
            return;
        }
        let text: String = self.entries.iter().map(|entry| format!("{entry}\n")).collect();
        let _ = fs::write(&self.path, text);
    }

    fn delete(&self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn log_path(key: &str) -> PathBuf {
    let safe: String = key
        .chars()
        .map(|character| if character.is_ascii_alphanumeric() || character == '-' { character } else { '_' })
        .collect();
    paths::agent_log_dir().join(format!("{safe}.ndjson"))
}

fn turn_end(session_id: Option<&str>, response: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": TURN_END,
        "params": {
            "sessionId": session_id,
            "stopReason": response.get("result").and_then(|result| result.get("stopReason")),
            "error": response.get("error"),
        },
    })
}

impl Agents {
    /// Agents whose logs outlived a previous daemon: their processes are gone,
    /// but a window can still collect what they reported.
    pub fn recover(dir: &Path) -> Self {
        let mut map = HashMap::new();
        for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("ndjson") {
                continue;
            }
            let Some(key) = path.file_stem().and_then(|stem| stem.to_str()).map(str::to_owned) else { continue };
            let mut state = AgentState::new(AgentLog::recover(path));
            state.exited = Some(None);
            state
                .stderr
                .push_back("Termy Code's background service restarted, so this agent stopped.".to_owned());
            map.insert(
                key.clone(),
                Arc::new(Agent {
                    key,
                    cwd: String::new(),
                    stdin: tokio::sync::Mutex::new(None),
                    kill: Mutex::new(None),
                    state: Mutex::new(state),
                }),
            );
        }
        Self { map: Mutex::new(map) }
    }

    fn get(&self, key: &str) -> Result<Arc<Agent>, String> {
        self.map
            .lock()
            .map_err(|_| "Agent registry poisoned".to_owned())?
            .get(key)
            .cloned()
            .ok_or_else(|| "That agent isn't running.".to_owned())
    }

    fn all(&self) -> Vec<Arc<Agent>> {
        self.map
            .lock()
            .map(|map| map.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn alive_count(&self) -> usize {
        self.all()
            .iter()
            .filter(|agent| agent.state.lock().is_ok_and(|state| state.exited.is_none()))
            .count()
    }

    pub fn list(&self) -> Value {
        Value::Array(
            self.all()
                .iter()
                .filter_map(|agent| Some(agent.state.lock().ok()?.summary(&agent.key, &agent.cwd)))
                .collect(),
        )
    }

    /// Everything after `after`, the requests still waiting for an answer, and live updates from now on.
    pub fn attach(&self, conn: ConnId, key: &str, after: u64) -> Result<Value, String> {
        let agent = self.get(key)?;
        let mut state = agent.state.lock().map_err(|_| "Agent poisoned")?;
        state.attached.insert(conn);
        let mut snapshot = state.summary(&agent.key, &agent.cwd);
        snapshot["entries"] = Value::Array(state.log.after(after));
        snapshot["pending"] = Value::Array(state.pending.clone());
        snapshot["latest"] = Value::Array(state.latest.values().cloned().collect());
        Ok(snapshot)
    }

    pub fn detach(&self, conn: ConnId, key: &str) {
        if let Ok(agent) = self.get(key) {
            if let Ok(mut state) = agent.state.lock() {
                state.attached.remove(&conn);
            }
        }
    }

    pub fn detach_all(&self, conn: ConnId) {
        for agent in self.all() {
            if let Ok(mut state) = agent.state.lock() {
                state.attached.remove(&conn);
            }
        }
    }

    pub fn ack(&self, key: &str, seq: u64) {
        if let Ok(agent) = self.get(key) {
            if let Ok(mut state) = agent.state.lock() {
                state.log.ack(seq);
            }
        }
    }

    fn remove(&self, key: &str) -> Option<Arc<Agent>> {
        self.map.lock().ok()?.remove(key)
    }

    pub fn kill_all(&self, daemon: &Daemon) {
        for agent in self.all() {
            agent.stop();
            daemon.terminals.release_owned_by(&agent.key);
        }
    }
}

impl Agent {
    fn stop(&self) {
        if let Some(kill) = self.kill.lock().ok().and_then(|mut kill| kill.take()) {
            let _ = kill.send(());
        }
    }

    async fn write(&self, message: &Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        let stdin = stdin.as_mut().ok_or("The agent has exited.")?;
        let mut line = message.to_string();
        line.push('\n');
        stdin.write_all(line.as_bytes()).await.map_err(|error| error.to_string())?;
        stdin.flush().await.map_err(|error| error.to_string())
    }
}

impl Daemon {
    pub async fn spawn_agent(self: &Arc<Self>, params: &Value) -> Result<Value, String> {
        let key = string(params, "key")?;
        let command = string(params, "command")?;
        let cwd = string(params, "cwd")?;
        let args: Vec<String> = serde_json::from_value(param(params, "args")?.clone()).map_err(|error| error.to_string())?;
        let env: HashMap<String, String> = params
            .get("env")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| error.to_string())?
            .unwrap_or_default();

        if let Ok(existing) = self.agents.get(&key) {
            if existing.state.lock().is_ok_and(|state| state.exited.is_none()) {
                return Err("An agent is already running for this thread.".to_owned());
            }
            self.kill_agent(&key);
        }

        let mut child = Command::new(&command)
            .args(&args)
            .current_dir(&cwd)
            .env("PATH", shell_env::login_path())
            .envs(&env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("Couldn't start `{command}`: {error}"))?;

        let stdin = child.stdin.take().ok_or("Agent has no stdin")?;
        let stdout = child.stdout.take().ok_or("Agent has no stdout")?;
        let stderr = child.stderr.take().ok_or("Agent has no stderr")?;
        let (kill_tx, kill_rx) = oneshot::channel();
        let agent = Arc::new(Agent {
            key: key.clone(),
            cwd,
            stdin: tokio::sync::Mutex::new(Some(stdin)),
            kill: Mutex::new(Some(kill_tx)),
            state: Mutex::new(AgentState::new(AgentLog::fresh(log_path(&key)))),
        });
        self.agents
            .map
            .lock()
            .map_err(|_| "Agent registry poisoned")?
            .insert(key, agent.clone());

        let daemon = self.clone();
        let reader = agent.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                // Agents sometimes log to stdout; anything that isn't JSON-RPC is noise.
                if let Ok(message) = serde_json::from_str::<Value>(&line) {
                    daemon.from_agent(&reader, message);
                }
            }
        });

        let tail = agent.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(mut state) = tail.state.lock() {
                    state.stderr.push_back(line);
                    if state.stderr.len() > STDERR_LINES {
                        state.stderr.pop_front();
                    }
                }
            }
        });

        let daemon = self.clone();
        let watched = agent.clone();
        tokio::spawn(async move {
            let status = tokio::select! {
                status = child.wait() => status.ok(),
                _ = kill_rx => {
                    let _ = child.kill().await;
                    child.wait().await.ok()
                }
            };
            daemon.agent_exited(&watched, status.and_then(|status| status.code()));
        });

        Ok(Value::Null)
    }

    fn agent_exited(&self, agent: &Arc<Agent>, code: Option<i32>) {
        self.terminals.release_owned_by(&agent.key);
        let Ok(mut state) = agent.state.lock() else { return };
        state.exited = Some(code);
        state.pending.clear();
        state.turn = None;
        let stderr = state.stderr.iter().cloned().collect::<Vec<_>>().join("\n");
        let attached: Vec<ConnId> = state.attached.iter().copied().collect();
        self.hub
            .event(attached, "agent.exit", json!({ "key": agent.key, "code": code, "stderr": stderr }));
    }

    /// Stops the agent for good and forgets its log.
    pub fn kill_agent(&self, key: &str) {
        if let Some(agent) = self.agents.remove(key) {
            agent.stop();
            if let Ok(state) = agent.state.lock() {
                state.log.delete();
            }
        }
        self.terminals.release_owned_by(key);
    }

    /// A JSON-RPC message from a window to the agent.
    pub async fn send_to_agent(&self, conn: ConnId, key: &str, mut message: Value) -> Result<Value, String> {
        let agent = self.agents.get(key)?;
        {
            let mut state = agent.state.lock().map_err(|_| "Agent poisoned")?;
            if state.exited.is_some() {
                return Err("The agent has exited.".to_owned());
            }
            let method = message.get("method").and_then(Value::as_str).map(str::to_owned);
            let id = message.get("id").cloned();
            match (method, id) {
                (Some(method), Some(client_id)) => {
                    let daemon_id = state.next_id;
                    state.next_id += 1;
                    let session_id = message
                        .pointer("/params/sessionId")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    if method == "session/prompt" {
                        state.turn = Some(json!({ "sessionId": session_id, "startedAt": now_ms() }));
                    }
                    if method == "session/load" {
                        state.loads += 1;
                    }
                    let mode_id = (method == "session/set_mode")
                        .then(|| message.pointer("/params/modeId").and_then(Value::as_str).map(str::to_owned))
                        .flatten();
                    state.outgoing.insert(
                        daemon_id,
                        Outgoing {
                            conn,
                            client_id,
                            method,
                            session_id,
                            mode_id,
                        },
                    );
                    message["id"] = json!(daemon_id);
                }
                // An answer to one of the agent's requests.
                (None, Some(id)) => state.pending.retain(|request| request.get("id") != Some(&id)),
                _ => {}
            }
        }
        agent.write(&message).await?;
        Ok(Value::Null)
    }

    /// A JSON-RPC message from the agent.
    fn from_agent(self: &Arc<Self>, agent: &Arc<Agent>, message: Value) {
        let method = message.get("method").and_then(Value::as_str).map(str::to_owned);
        let id = message.get("id").cloned();
        match (method, id) {
            (Some(method), Some(id)) if method.starts_with("fs/") || method.starts_with("terminal/") => {
                let daemon = self.clone();
                let agent = agent.clone();
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                tokio::spawn(async move {
                    let response = match daemon.client_request(&agent.key, &method, &params).await {
                        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                        Err(error) => json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": -32603, "message": error },
                        }),
                    };
                    let _ = agent.write(&response).await;
                });
            }
            (Some(_), Some(_)) => {
                let Ok(mut state) = agent.state.lock() else { return };
                state.pending.push(message.clone());
                let attached: Vec<ConnId> = state.attached.iter().copied().collect();
                self.hub
                    .event(attached, "agent.message", json!({ "key": agent.key, "message": message }));
            }
            (Some(method), None) => {
                let Ok(mut state) = agent.state.lock() else { return };
                if method == "session/update" {
                    if let Some(update) = message.pointer("/params/update").cloned() {
                        let session_id = message.pointer("/params/sessionId").and_then(Value::as_str).map(str::to_owned);
                        state.remember_state(session_id.as_deref(), update);
                    }
                }
                let replay = state.loads > 0;
                let entry = state.log.append(replay, message);
                let attached: Vec<ConnId> = state.attached.iter().copied().collect();
                self.hub.event(attached, "agent.entry", json!({ "key": agent.key, "entry": entry }));
            }
            (None, Some(id)) => {
                let Ok(mut state) = agent.state.lock() else { return };
                let Some(outgoing) = id.as_u64().and_then(|id| state.outgoing.remove(&id)) else { return };
                let result = message.get("result");
                match outgoing.method.as_str() {
                    "initialize" => state.initialize = result.cloned(),
                    "session/new" | "session/resume" | "session/load" | "session/fork" => {
                        if outgoing.method == "session/load" {
                            state.loads = state.loads.saturating_sub(1);
                        }
                        if let Some(result) = result {
                            state.session = Some(result.clone());
                            state.session_id = result
                                .get("sessionId")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                                .or(outgoing.session_id.clone());
                        }
                    }
                    "session/set_config_option" => {
                        if let Some(options) = result.and_then(|result| result.get("configOptions")) {
                            let update = json!({ "sessionUpdate": "config_option_update", "configOptions": options });
                            state.remember_state(outgoing.session_id.as_deref(), update);
                        }
                    }
                    "session/set_mode" => {
                        if let (Some(_), Some(mode_id)) = (result, outgoing.mode_id.as_deref()) {
                            let update = json!({ "sessionUpdate": "current_mode_update", "currentModeId": mode_id });
                            state.remember_state(outgoing.session_id.as_deref(), update);
                        }
                    }
                    "session/prompt" => {
                        state.turn = None;
                        let entry = state.log.append(false, turn_end(outgoing.session_id.as_deref(), &message));
                        let attached: Vec<ConnId> = state.attached.iter().copied().collect();
                        self.hub.event(attached, "agent.entry", json!({ "key": agent.key, "entry": entry }));
                    }
                    _ => {}
                }
                let mut reply = message.clone();
                reply["id"] = outgoing.client_id;
                self.hub.event(
                    [outgoing.conn],
                    "agent.message",
                    json!({ "key": agent.key, "message": reply }),
                );
            }
            (None, None) => {}
        }
    }

    /// The client side of ACP that doesn't need a person: files and commands.
    async fn client_request(&self, owner: &str, method: &str, params: &Value) -> Result<Value, String> {
        let text = |name: &str| string(params, name);
        let count = |name: &str| params.get(name).and_then(Value::as_u64).map(|value| value as usize);
        match method {
            "fs/read_text_file" => {
                let content = workspace::read_text(&text("path")?, count("line"), count("limit")).await?;
                Ok(json!({ "content": content }))
            }
            "fs/write_text_file" => {
                workspace::write_text(&text("path")?, &text("content")?).await?;
                Ok(json!({}))
            }
            "terminal/create" => {
                let request: CreateRequest = serde_json::from_value(params.clone()).map_err(|error| error.to_string())?;
                let hub = self.hub.clone();
                let sink: crate::agent_terminal::Sink = Arc::new(move |name, data| hub.broadcast(name, data));
                let terminal_id = self.terminals.create(owner, request, sink)?;
                Ok(json!({ "terminalId": terminal_id }))
            }
            "terminal/output" => serde_json::to_value(self.terminals.output(&text("terminalId")?)?)
                .map_err(|error| error.to_string()),
            "terminal/wait_for_exit" => serde_json::to_value(self.terminals.wait(&text("terminalId")?).await?)
                .map_err(|error| error.to_string()),
            "terminal/kill" => {
                self.terminals.kill(&text("terminalId")?)?;
                Ok(json!({}))
            }
            "terminal/release" => {
                self.terminals.release(&text("terminalId")?)?;
                Ok(json!({}))
            }
            other => Err(format!("Termy Code doesn't support `{other}`")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_numbers_entries_and_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("termy-log-test-{}", std::process::id()));
        let path = dir.join("thread.ndjson");
        let mut log = AgentLog::fresh(path.clone());
        log.append(false, json!({ "method": "session/update", "params": { "n": 1 } }));
        log.append(true, json!({ "method": "session/update", "params": { "n": 2 } }));
        log.append(false, json!({ "method": "session/update", "params": { "n": 3 } }));
        assert_eq!(log.after(1).len(), 2);

        log.ack(2);
        let recovered = AgentLog::recover(path.clone());
        assert_eq!(recovered.entries.len(), 1);
        assert_eq!(recovered.entries[0]["seq"], 3);
        assert_eq!(recovered.next_seq, 4);

        log.ack(3);
        assert!(!path.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn turn_end_carries_the_stop_reason_or_the_error() {
        let done = turn_end(Some("s1"), &json!({ "id": 4, "result": { "stopReason": "end_turn" } }));
        assert_eq!(done["method"], TURN_END);
        assert_eq!(done["params"]["stopReason"], "end_turn");
        assert!(done["params"]["error"].is_null());

        let failed = turn_end(Some("s1"), &json!({ "id": 4, "error": { "code": -32000, "message": "auth" } }));
        assert_eq!(failed["params"]["error"]["message"], "auth");
    }
}
