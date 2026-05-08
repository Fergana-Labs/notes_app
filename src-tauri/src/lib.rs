mod commands;
mod config;
mod db;
mod error;
mod parser;
mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::switch_workspace,
            commands::move_workspace,
            commands::workspace_path,
            commands::list_blocks,
            commands::list_blocks_by_tag,
            commands::list_tags,
            commands::search,
            commands::save_blocks,
            commands::list_versions,
            commands::write_text_file,
            commands::get_setting,
            commands::set_setting,
            commands::create_backup,
            commands::list_backups,
            commands::restore_backup,
            commands::preview_backup,
            commands::should_backup,
            commands::export_canvas,
            commands::blocks_mtime,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
