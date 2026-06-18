mod commands;
mod config;
mod db;
mod error;
mod parser;
mod state;
mod sync;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::default())
        .setup(|app| {
            // Background sync: capture local/agent changes, push, pull + apply.
            // Quietly no-ops until a workspace is open and paired.
            let app_state = app.state::<AppState>().inner().clone();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri::Emitter;
                let http = reqwest::Client::new();
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(3));
                loop {
                    tick.tick().await;
                    if let Ok(stats) = sync::client::sync_once(&app_state, &http).await {
                        // Writes land in the WAL, so blocks.db's mtime doesn't move
                        // and the mtime poller won't notice. Tell the frontend to
                        // reload directly whenever a pull actually changed data.
                        if stats.applied > 0 {
                            let _ = app_handle.emit("sync-applied", stats.applied);
                        }
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::switch_workspace,
            commands::move_workspace,
            commands::workspace_path,
            commands::list_blocks,
            commands::list_blocks_by_tag,
            commands::list_tags,
            commands::set_tag_description,
            commands::reorder_tags,
            commands::set_tag_priority,
            commands::set_tag_folder,
            commands::delete_tag,
            commands::remove_tag_from_block,
            commands::coach_list_conversations,
            commands::coach_list_messages,
            commands::search,
            commands::save_blocks,
            commands::list_versions,
            commands::list_trash,
            commands::restore_block,
            commands::purge_block,
            commands::empty_trash,
            commands::list_daily_notes,
            commands::get_daily_note,
            commands::search_daily_notes,
            commands::save_daily_note,
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
            sync::commands::sync_pair,
            sync::commands::sync_status,
            sync::commands::sync_unpair,
            sync::commands::sync_tick,
            sync::commands::audio_note_ids,
            sync::commands::audio_fetch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
