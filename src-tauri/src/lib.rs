mod cli;
mod fs_cmds;
mod fs_watch;
mod git;
mod lsp;
mod mcp;
mod memory;
mod providers;
mod session;
mod tasks;
mod terminal;
mod window_cmds;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(providers::ProviderState::default())
        .manage(fs_watch::WatcherState::default())
        .manage(cli::InitialFolder::from_args())
        .manage(terminal::TerminalState::default())
        .manage(lsp::LspState::default())
        .setup(|app| {
            // The main window is configured hidden; size it to the real
            // monitor work area, maximize and show (see fit_and_maximize).
            if let Some(window) = app.get_webview_window("main") {
                window_cmds::fit_and_maximize(&window);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                fs_watch::drop_watcher_for(window);
                terminal::kill_for_window(window);
                lsp::stop_for_window(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            cli::initial_folder,
            fs_cmds::list_dir,
            fs_cmds::list_files,
            fs_cmds::read_file,
            fs_cmds::write_file,
            fs_cmds::create_dir,
            fs_cmds::rename_path,
            fs_cmds::delete_path,
            fs_watch::watch_workspace,
            fs_watch::unwatch_workspace,
            terminal::term_create,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_kill,
            providers::ai_send_prompt,
            providers::ai_cancel,
            providers::ai_oneshot,
            providers::provider_health,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_push,
            git::git_pull,
            git::git_init,
            git::git_show_head,
            git::git_staged_diff,
            git::git_worktree_diff,
            git::git_file_diff,
            git::git_log,
            git::git_show_commit,
            git::git_branches,
            git::git_checkout,
            git::git_create_branch,
            git::git_blame,
            git::git_stash_list,
            git::git_stash_push,
            git::git_stash_apply,
            git::git_stash_pop,
            git::git_stash_drop,
            session::load_ai_sessions,
            session::save_ai_sessions,
            memory::memory_paths,
            memory::ensure_memory_bridge,
            tasks::detect_tasks,
            tasks::task_command_line,
            mcp::mcp_list,
            mcp::mcp_add,
            mcp::mcp_remove,
            mcp::mcp_login_command,
            lsp::lsp_availability,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            window_cmds::open_new_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
