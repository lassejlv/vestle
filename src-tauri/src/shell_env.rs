//! GUI apps on macOS start with a minimal PATH, so `npx`, `agent` and friends
//! are invisible. Resolve the user's login-shell PATH once and reuse it.

use std::{process::Command, sync::OnceLock};

const MARKER: &str = "__TERMY_PATH__";

static LOGIN_PATH: OnceLock<String> = OnceLock::new();

pub fn login_path() -> &'static str {
    LOGIN_PATH.get_or_init(|| resolve().unwrap_or_else(fallback))
}

fn resolve() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let script = format!("printf '{MARKER}%s{MARKER}' \"$PATH\"");
    let output = Command::new(shell).args(["-ilc", &script]).output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let start = stdout.find(MARKER)? + MARKER.len();
    let end = start + stdout[start..].find(MARKER)?;
    let path = stdout[start..end].trim();
    (!path.is_empty()).then(|| path.to_owned())
}

fn fallback() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let current = std::env::var("PATH").unwrap_or_default();
    [
        format!("{home}/.local/bin"),
        format!("{home}/.bun/bin"),
        format!("{home}/.cargo/bin"),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        current,
    ]
    .join(":")
}
