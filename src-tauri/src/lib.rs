mod aime_dir;
mod archive;
mod checkpoint;
mod cli;
mod cloud;
mod dap;
mod diagnostics;
mod environment;
mod exec;
mod fs_cmds;
mod fs_watch;
mod git;
mod lsp;
mod mcp;
mod memory;
mod plugins;
mod program;
mod providers;
mod session;
mod splash;
mod tasks;
mod terminal;
mod trackers;
mod updates;
mod window_cmds;
mod wire;

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
        .manage(dap::DapState::default())
        .manage(exec::ExecState::default())
        .manage(splash::SplashState::default())
        .setup(|app| {
            // The editor stays hidden behind the splash window until the
            // frontend reports its first screen painted; splash.rs owns that
            // handover, and shows the editor straight away when there is no
            // splash to show (see splash::start).
            splash::start(app.handle());
            // User-defined AI CLIs: a bad file costs its own providers, never
            // the built-in ones. Watched from here on, so a CLI added while
            // Aime runs - by the user or by the agent doing it for them -
            // appears without a restart.
            if let Ok(config_dir) = app.path().app_config_dir() {
                providers::generic::install(providers::generic::load(&config_dir.join("providers.json")));
                fs_watch::watch_providers_config(app.handle(), &config_dir);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                fs_watch::drop_watcher_for(window);
                terminal::kill_for_window(window);
                lsp::stop_for_window(window);
                dap::stop_for_window(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            cli::initial_folder,
            cloud::cloud_report,
            splash::splash_shown,
            splash::splash_hold,
            splash::splash_skip,
            splash::app_ready,
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
            diagnostics::report_error,
            diagnostics::error_log_path,
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
            providers::provider_set_api_key,
            providers::list_providers,
            providers::providers_reload,
            providers::providers_config_path,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_ignore,
            git::git_untrack_and_ignore,
            git::git_commit,
            git::git_push,
            git::git_pull,
            git::git_init,
            git::git_show_head,
            git::git_pending_diff,
            git::git_file_diff,
            git::git_ignored,
            git::git_log,
            git::git_commit_detail,
            git::git_show_commit_file,
            git::git_branches,
            git::git_checkout_tracking,
            git::git_worktree_add,
            git::git_worktree_remove,
            git::git_commit_all,
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
            memory::project_memory_paths,
            memory::ensure_memory_bridge,
            tasks::detect_tasks,
            exec::exec_run,
            exec::exec_cancel,
            tasks::task_command_line,
            tasks::check_task_commands,
            tasks::save_tasks,
            tasks::task_profile_exists,
            tasks::worktree_setup_command,
            mcp::mcp_list,
            mcp::mcp_add,
            mcp::mcp_remove,
            mcp::mcp_login_command,
            lsp::lsp_availability,
            lsp::lsp_download,
            lsp::lsp_project_files,
            lsp::lsp_restore,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            lsp::edits::apply_text_edits,
            dap::catalog::dap_availability,
            dap::catalog::dap_download,
            dap::catalog::dap_program,
            dap::targets::dap_targets,
            dap::learned::dap_mark_verified,
            dap::learned::dap_devices,
            dap::options::dap_launch_options,
            dap::options::dap_set_launch_options,
            dap::dap_start,
            dap::dap_connect,
            dap::dap_send,
            dap::dap_stop,
            trackers::tracker_kinds,
            trackers::tracker_connections,
            trackers::tracker_binding,
            trackers::tracker_bind,
            trackers::tracker_unbind,
            trackers::tracker_connect,
            trackers::tracker_disconnect,
            trackers::tracker_work_items,
            trackers::tracker_item_detail,
            trackers::tracker_states,
            trackers::tracker_comments,
            trackers::tracker_add_comment,
            trackers::tracker_set_state,
            plugins::plugin_list,
            plugins::plugin_source,
            plugins::plugins_folder,
            window_cmds::open_new_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
