mod agent_terminal;
pub mod daemon;
mod daemon_client;
mod db;
mod mentions;
mod paths;
mod pty;
mod shell_env;
mod workspace;

use tauri::Manager;

#[tauri::command]
fn updater_enabled() -> bool {
    cfg!(all(target_os = "macos", not(debug_assertions)))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Warm the login-shell PATH off the main thread so the first spawn is instant.
    std::thread::spawn(shell_env::login_path);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(db::Db::open(&dir.join("termy.db"))?);
            // Agents and shells live in the background daemon, so they outlive this window.
            app.manage(daemon_client::DaemonClient::new(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            updater_enabled,
            daemon_client::daemon_request,
            daemon_client::daemon_info,
            daemon_client::daemon_restart,
            workspace::fs_read_text,
            workspace::fs_write_text,
            workspace::git_branch,
            workspace::fs_read_image,
            mentions::project_files,
            mentions::skills_list,
            db::db_projects_list,
            db::db_project_save,
            db::db_project_delete,
            db::db_threads_list,
            db::db_threads_search,
            db::db_thread_get,
            db::db_thread_save,
            db::db_thread_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Termy Code");
}
