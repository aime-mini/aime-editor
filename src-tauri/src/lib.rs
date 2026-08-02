mod checkpoint;
mod cli;
mod environment;
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
mod updates;
mod window_cmds;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            // User-defined AI CLIs, read once: a bad file costs its own
            // providers, never the built-in ones.
            if let Ok(config_dir) = app.path().app_config_dir() {
                providers::generic::install(providers::generic::load(&config_dir.join("providers.json")));
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
            checkpoint::checkpoint_create,
            checkpoint::checkpoint_diff,
            checkpoint::checkpoint_restore,
            environment::environment_report,
            environment::language_server_report,
            environment::login_command_for,
            environment::install_tool,
            environment::unattended_setup_targets,
            fs_cmds::list_dir,
            fs_cmds::list_files,
            updates::update_check,
            updates::update_install,
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
            providers::list_providers,
            providers::providers_config_path,
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
            git::git_rename_branch,
            git::git_delete_branch,
            git::git_merge_branch,
            git::git_remotes,
            git::git_set_remote,
            git::git_fetch,
            git::git_clone,
            git::git_tags,
            git::git_create_tag,
            git::git_delete_tag,
            git::git_push_tags,
            git::git_revert_commit,
            git::git_cherry_pick,
            git::git_reset_to,
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
            lsp::edits::apply_text_edits,
            window_cmds::open_new_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
