// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The same binary is also the background daemon that keeps agents and shells running.
    if std::env::args().any(|arg| arg == "--daemon") {
        termy_code_lib::daemon::run();
    } else {
        termy_code_lib::run();
    }
}
