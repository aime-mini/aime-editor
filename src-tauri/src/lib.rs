mod aime_dir;
mod archive;
mod background;
mod checkpoint;
mod cli;
mod cloud;
mod dap;
mod diagnostics;
mod environment;
mod exec;
mod flow_services;
mod flows;
mod fs_cmds;
mod fs_watch;
mod git;
mod git_ignored;
mod home;
mod login_shell;
mod lsp;
mod mcp;
mod memory;
mod memory_mirror;
mod net;
mod page_preview;
mod page_probe;
mod plugins;
mod program;
mod providers;
mod session;
mod splash;
mod tasks;
mod terminal;
mod trackers;
mod transfer;
mod updates;
mod window_cmds;
mod wire;
mod workspaces;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First of all, before any process is spawned: the PATH the person's
    // shell has, which an app opened from the Dock does not get by itself.
    login_shell::adopt();
    tauri::Builder::default()
        // First, so a second `aime` launch reaches this one instead of starting
        // another app: `aime run <flow>` is a request to the open window, and
        // `aime <folder>` opens the folder here.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            use tauri::Emitter;
            if let Some(request) = flow_services::run_request(&args, std::path::Path::new(&cwd)) {
                if let Err(err) = app.emit("flows:run-request", &request) {
                    eprintln!("[flows] could not hand the run request to the window: {err}");
                }
                return;
            }
            if let Some(folder) = args.get(1).cloned().and_then(cli::resolve_folder_arg) {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = workspaces::open_folder_anywhere(&app, folder).await {
                        eprintln!("[workspaces] could not open the folder a second launch asked for: {err}");
                    }
                });
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .register_asynchronous_uri_scheme_protocol(page_preview::SCHEME, page_preview::serve)
        .manage(providers::ProviderState::default())
        .manage(page_preview::PagePreviews::default())
        .manage(fs_watch::WatcherState::default())
        .manage(terminal::TerminalState::default())
        .manage(lsp::LspState::default())
        .manage(dap::DapState::default())
        .manage(exec::ExecState::default())
        .manage(splash::SplashState::default())
        .manage(session::closing::ClosingWindows::default())
        .manage(workspaces::Workspaces::default())
        .manage(cloud::sign_in::SignInState::default())
        .manage(cloud::credentials::CredentialWatch::default())
        .setup(|app| {
            app.state::<workspaces::Workspaces>()
                .load_remembered(app.handle());
            // The editor is built hidden and stays behind the splash window
            // until its first workspace reports its first screen painted;
            // splash.rs owns that handover, and shows the editor straight away
            // when there is no splash to show (see splash::start).
            workspaces::open_first(app.handle(), cli::folder_from_args())?;
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
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => session::closing::hold_close(window, api),
            tauri::WindowEvent::Resized(_) => workspaces::layout(window),
            tauri::WindowEvent::Destroyed => workspaces::window_gone(window.app_handle(), window.label()),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            cli::initial_folder,
            page_probe::page_probe,
            cloud::cloud_report,
            cloud::cloud_status,
            cloud::cloud_accounts,
            cloud::cloud_billing_accounts,
            cloud::cloud_resources,
            cloud::cloud_set_account,
            cloud::reads::cloud_read_plan,
            cloud::reads::cloud_forget_plan,
            cloud::reads::cloud_check_reads,
            cloud::reads::cloud_prove_read,
            cloud::reads::cloud_store_plan,
            cloud::reads::cloud_run_read,
            cloud::reads::cloud_read_catalog,
            cloud::reads::cloud_cli_commands,
            cloud::sign_in::cloud_sign_in,
            cloud::sign_in::cloud_sign_in_code,
            cloud::sign_in::cloud_sign_in_cancel,
            cloud::credentials::cloud_watch_credentials,
            cloud::deploy::cloud_check_deploy,
            cloud::deploy::cloud_deploy_step,
            cloud::deploy::cloud_deploy_read,
            cloud::deploy::cloud_http_probe,
            cloud::deploy::programs_present,
            splash::splash_shown,
            splash::splash_skip,
            splash::splash_decline,
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
            fs_cmds::path_kinds,
            fs_cmds::open_folder,
            page_preview::page_preview_root,
            fs_cmds::list_files,
            diagnostics::report_error,
            diagnostics::error_log_path,
            updates::update_check,
            updates::update_install,
            fs_cmds::read_file,
            fs_cmds::opens_as_text,
            fs_cmds::read_image,
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
            providers::ai_steer,
            providers::ai_withdraw,
            providers::ai_oneshot,
            providers::provider_health,
            providers::provider_set_api_key,
            providers::list_providers,
            providers::background_turns_allowed,
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
            git::repositories::git_repositories,
            git::git_checkout_tracking,
            git::git_worktree_add,
            git::git_worktree_remove,
            git::git_worktree_discard,
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
            session::load_workspace_state,
            session::save_workspace_state,
            session::closing::window_flushed,
            memory::project_memory_paths,
            memory::ensure_memory_bridge,
            memory_mirror::memory_mirror_sync,
            transfer::transfer_export,
            flows::flow_list,
            flows::flow_save,
            flows::flow_delete,
            flows::flow_journal_append,
            flows::flow_journal_read,
            flows::flow_runs,
            flows::flow_jq,
            flows::flow_run_program,
            flows::host_platform,
            flows::my_flow_list,
            flows::my_flow_save,
            flows::my_flow_delete,
            flow_services::secret_set,
            flow_services::secret_delete,
            flow_services::secret_names,
            flow_services::flow_http,
            flow_services::mail_account_set,
            flow_services::flow_mail,
            flow_services::oauth_sign_in,
            flow_services::oauth_token,
            flow_services::flow_trusted,
            flow_services::flow_trust,
            transfer::transfer_import,
            providers::catalog::provider_models,
            providers::catalog::provider_light_model,
            providers::ran_on::provider_ran_on,
            providers::next_run::provider_next_run,
            tasks::detect_tasks,
            exec::exec_run,
            exec::exec_cancel,
            net::net_reachable,
            workspaces::workspace_register,
            workspaces::workspace_tabs,
            workspaces::workspace_open,
            workspaces::workspace_switch,
            workspaces::workspace_reorder,
            workspaces::workspace_detach,
            workspaces::workspace_close,
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
            workspaces::open_new_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
