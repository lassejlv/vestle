//! Where the app and its background daemon keep files. Both processes must
//! agree without Tauri's path resolver, since the daemon runs without Tauri.

use std::path::PathBuf;

/// Matches `identifier` in tauri.conf.json, which is where Tauri puts app data.
const IDENTIFIER: &str = "dev.termy.code";

/// macOS limits a Unix socket path to 104 bytes.
const MAX_SOCKET_PATH: usize = 100;

pub fn data_dir() -> PathBuf {
    // Lets tests (and a second dev copy) run without touching the real app's data.
    if let Some(dir) = std::env::var_os("TERMY_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support").join(IDENTIFIER)
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join(IDENTIFIER)
    }
}

/// The daemon's socket. Falls back to the temp dir when the data dir path is too long.
pub fn socket_path() -> PathBuf {
    let preferred = data_dir().join("daemon.sock");
    if preferred.as_os_str().len() <= MAX_SOCKET_PATH {
        return preferred;
    }
    let user = std::env::var("USER").unwrap_or_else(|_| "user".to_owned());
    std::env::temp_dir().join(format!("termy-code-{user}.sock"))
}

/// Agent logs: what each agent said while no window was watching.
pub fn agent_log_dir() -> PathBuf {
    data_dir().join("daemon").join("agents")
}

pub fn daemon_log_file() -> PathBuf {
    data_dir().join("daemon").join("daemon.log")
}
