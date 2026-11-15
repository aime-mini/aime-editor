import type { Locale } from "../i18n";

/**
 * Content of the in-app Help screen (F1).
 *
 * RULE (user requirement): every user-facing feature change MUST update this
 * file — both locales — in the same commit. The Help screen is generated
 * entirely from this list; `keywords` feed the search on top of title + body.
 */
export interface HelpTopic {
  id: string;
  section: string;
  title: string;
  body: string;
  keywords?: string;
}

const EN: HelpTopic[] = [
  {
    id: "open-project",
    section: "Getting started",
    title: "Open a project",
    body: "On the welcome screen: Open Folder, Recent (the last 8 workspaces; x removes one from the list), New Project, and Clone Repository (clones a git URL and opens it). The line at the bottom shows whether the AI CLIs, Git, Node and language servers are ready; click it to see how to fix anything missing.",
    keywords: "workspace recent folder start clone git url github logo",
  },
  {
    id: "updates",
    section: "Getting started",
    title: "Updates",
    body: "Aime checks for a new version at launch and shows a bar when there is one. Nothing downloads until you press Update now. Updates are signed; a build without a valid signature is refused.",
    keywords: "update upgrade version release auto-update signed",
  },
  {
    id: "splash",
    section: "Getting started",
    title: "The starting window",
    body: "A short start card is shown while the project loads. Press any key or click to skip it, or turn off 'Starting window' in Settings.",
    keywords: "splash startup launch start screen logo skip loading animation",
  },
  {
    id: "cli",
    section: "Getting started",
    title: "Open from the terminal",
    body: "Type `aime .` in a terminal to open the current folder, or `aime <path>` for another one. A running app is reused.",
    keywords: "command line launcher code",
  },
  {
    id: "multi-window",
    section: "Getting started",
    title: "Multiple projects at once",
    body: "Ctrl+Shift+N, the window button in the status bar, or New Window on the welcome screen opens a separate window with its own project, AI chat and terminals.",
    keywords: "new window parallel",
  },
  {
    id: "switch-close",
    section: "Workspace",
    title: "Switch or close the workspace",
    body: "Hover the project name above the file tree: the folder icon opens another workspace, X closes it. A workspace reopens as you left it, with its tabs, cursor positions and unsaved text. If a file changed on disk meanwhile, choose Keep my edits or the version on disk. Terminals, debug sessions and running tasks are not restored.",
    keywords: "close folder back exit change project restore reopen tabs session unsaved hot exit",
  },
  {
    id: "file-tree",
    section: "Workspace",
    title: "File tree",
    body: "Click opens a file. Right-click for Open, Reveal in File Explorer, Git Blame, New File, New Folder, Rename and Delete. Drag & drop moves items into a folder, next to a file, or to the root (drop on the project name). If an action fails, the reason appears at the top of the tree.",
    keywords: "drag drop move create rename delete context menu reveal explorer blame error failed",
  },
  {
    id: "live-updates",
    section: "Workspace",
    title: "Live updates",
    body: "Changes made outside the editor, including the AI's edits, appear in the file tree and open files automatically.",
    keywords: "watcher refresh sync gitignore ignored lag busy",
  },
  {
    id: "editor",
    section: "Editor",
    title: "Editing & saving",
    body: "Each open folder is a tab in the strip at the top: + opens another, drag to reorder, right-click to move it to its own window. Workspaces in the background keep running. Each file opens in its own tab; a dot marks unsaved changes, Ctrl+W closes, right-click for Close Others, Close Saved, Copy Path and more. Ctrl+S saves; auto save (on by default, see Settings) saves one second after you stop typing. .csv/.tsv files open as a table, .md as a rendered page, .json/.xml as a tree; the Text button shows the raw text. For .html, View shows the page.",
    keywords:
      "save dirty modified undo ctrl+z monaco tab tabs multiple files close switch sticky scroll outline symbols",
  },
  {
    id: "encoding",
    section: "Editor",
    title: "Files that begin with a byte order mark",
    body: "Files with a UTF-8 byte order mark (BOM) open with it hidden and keep it on save, so opening and saving one does not change it in git.",
    keywords: "bom byte order mark utf-8 encoding visual studio c# diff patch glyph",
  },
  {
    id: "lsp",
    section: "Editor",
    title: "Code intelligence (completions, types, go to definition)",
    body: "Completions, hover info, F12 or Ctrl+click (go to definition), Ctrl+F12 (implementations), Shift+F12 (references), F2 (rename across the project) and live errors come from the same language servers VS Code uses. TypeScript, JavaScript, HTML, CSS and JSON work out of the box; servers for Python, PHP, SQL, shell, YAML and Dockerfile (and Go and Rust when their toolchain is installed) install automatically. For other languages, opening a file offers to install its server (C# about 65 MB; Java about 45 MB and needs JDK 17+). The language chip in the status bar: green = running, amber = missing (the tooltip shows the install command), spinning = loading.",
    keywords:
      "lsp intellisense completion autocomplete hover definition implementation references f12 diagnostics errors gopls pyright rust-analyzer",
  },
  {
    id: "plugins",
    section: "Editor",
    title: "Plugins",
    body: "A plugin is a folder with a plugin.json and a script in Aime's plugins folder (open it from Settings). Enable it in Settings; it runs sandboxed with only the permissions it declares and adds commands to the command palette. A plugin that hangs or misbehaves is stopped. Plugins are never loaded from a project.",
    keywords: "plugin extension api sandbox worker capabilities commands",
  },
  {
    id: "ai-requirements",
    section: "AI",
    title: "What the AI needs (and what works without it)",
    body: "The AI needs an AI CLI on your machine: Claude Code (npm install -g @anthropic-ai/claude-code) or Codex (npm install -g @openai/codex). Aime shows the install command or a sign-in button when needed. Without AI, everything else works.",
    keywords: "install login sign in requirements offline manual no ai codex claude",
  },
  {
    id: "ai-provider",
    section: "AI",
    title: "Choose the AI CLI & sign in",
    body: "The first chip in the AI panel header picks the AI CLI; switching starts a new session. The key button next to it signs in with the CLI's own login in a terminal tab. If a sign-in expires, press Sign in again, then Continue. To use an API key instead, go to Settings > AI > API key; the key stays on this machine (for Codex it replaces the signed-in account, so Aime asks first).",
    keywords:
      "provider switch codex claude login sign in key account api key anthropic token expired sign in again relogin 401",
  },
  {
    id: "ai-add-provider",
    section: "AI",
    title: "Use another AI CLI",
    body: "To add another AI CLI (Gemini, for example): Settings > AI > Add an AI CLI, enter its name, and the AI writes the configuration. Or edit providers.json yourself: 'Add an AI CLI' in the command palette opens it with an example. Changes apply immediately. On Windows, a CLI installed with npm needs promptStdin: true.",
    keywords: "providers.json generic adapter gemini custom cli add provider reload restart",
  },
  {
    id: "ai-chat",
    section: "AI",
    title: "Chat with the AI",
    body: "Type a prompt and press Enter (Shift+Enter for a new line). The AI reads and edits the project and runs commands; its steps appear as chips you can expand. It automatically sees the open file, your selection and what is on screen. The line under the chat shows what it is doing, and each turn ends with its cost and duration. Stop cancels a turn; Continue resumes an interrupted one. You can send more messages while it works: they wait in line and can be taken back (x), edited (pencil) or sent now (arrow). File and folder names in answers are clickable.",
    keywords:
      "prompt send agent tool steps subagent background stop continue resume interrupted queue queued message take back edit send now link file folder",
  },
  {
    id: "ai-model",
    section: "AI",
    title: "Model & effort",
    body: "The chips above the chat choose the model and reasoning effort. The model list comes from the installed CLI, so new models appear automatically. Auto uses the CLI's default and shows what that is.",
    keywords: "opus sonnet haiku fable gpt codex gemini version xhigh ultra effort picker catalog list",
  },
  {
    id: "ai-approve",
    section: "AI",
    title: "How much the AI may do (permissions)",
    body: "The shield chip sets what the AI may do: FULL (everything, without asking), EDITS (edits files; commands only within the CLI's own rules) or READ-ONLY (reads and explains, changes nothing).",
    keywords: "permission bypass sandbox read-only plan command safety shield",
  },
  {
    id: "ai-usage",
    section: "AI",
    title: "Usage & cost",
    body: "The activity button above the chat shows this session's tokens, and its cost when the CLI reports one (Claude Code does; Codex shows tokens only).",
    keywords: "tokens cost money spend activity subscription",
  },
  {
    id: "ai-undo",
    section: "AI",
    title: "Taking a turn back",
    body: "Under each answer that changed files, Undo this turn puts them back as they were before your message and removes files the AI created. Your own staged work is kept. Requires git.",
    keywords: "undo revert rollback checkpoint mistake ai changed files safety",
  },
  {
    id: "ai-sessions",
    section: "AI",
    title: "Sessions & memory",
    body: "Chats are saved per project and continue after a restart. The history button lists the last 20 sessions, + starts a new one, and the pencil renames one. Aime keeps its notes in .aime/, which git ignores.",
    keywords: "resume history restore context progress journal remember gitignore commit",
  },
  {
    id: "cloud",
    section: "AI",
    title: "Cloud panel and deploy",
    body: "The cloud button in the status bar opens the cloud panel: Azure, AWS, Google Cloud and Supabase as tabs, and the accounts each cloud's CLI is signed in to on the left. Pick an account to see its Resources, or its Applications drawn as diagrams. Click a resource for Overview, Connect (endpoints to copy), Deployed alongside and Raw; secrets load only when you click Reveal and are never sent to the AI. 'What you can do to this' runs common operations such as logs, restart or scaling; changes show the command first, and deleting requires typing the resource's name. Deploy on an account header deploys the open project: the AI writes a plan, a confirm page lists every command and file, and nothing runs until you press Deploy. Past deploys are kept in .aime/deploy/history. Sign in from the panel or any terminal. Write to AI memory saves what runs in the account into AGENTS.md so the AI knows it.",
    keywords:
      "cloud azure aws gcp google supabase connect sign in login cli account subscription project resources applications diagram endpoint secret reveal operations deploy history memory agents.md",
  },
  {
    id: "mcp",
    section: "AI",
    title: "MCP servers (the AI's plugins)",
    body: "The plug button in the AI panel header (or 'MCP servers…' in the command palette) manages MCP servers, extra tools the AI can use. 'Browse & search servers' lists popular servers and searches the official registry; you can also enter a URL or a command. Claude Code keeps servers per project, Codex globally.",
    keywords: "mcp plugin tools server add remove connector github notion",
  },
  {
    id: "git",
    section: "Git",
    title: "Git panel",
    body: "The Git tab in the sidebar shows your changes: stage, unstage, discard, commit (Ctrl+Enter), push and pull. Committing with nothing staged stages everything. Click a file to see its diff (One column for a single-column view). History lists commits. The file tree and the editor gutter mark changes. The sparkle button writes the commit message with AI.",
    keywords: "commit stage diff push pull branch source control version init",
  },
  {
    id: "git-repositories",
    section: "Git",
    title: "Several repositories in one folder",
    body: "In a folder with several repositories (a frontend and a backend, for example), the Git panel shows one chip per repository; click one to work on it. Opening a file switches to its repository. A folder without git offers Initialize repository.",
    keywords:
      "multiple repositories monorepo multi-repo frontend backend parent folder subfolder switcher chip",
  },
  {
    id: "git-review",
    section: "Git",
    title: "A second opinion before you commit",
    body: "Review, next to Commit, asks the AI to check what you are about to commit. Problems show a red !, notes a dot; click one to open its file. It never blocks a commit.",
    keywords: "review ai second opinion before commit findings issues suggestions",
  },
  {
    id: "git-branches",
    section: "Git",
    title: "Branches, remotes and tags",
    body: "Click the branch name to switch, create, rename, merge or delete branches; remote branches are listed too, and picking one checks it out. Type to filter a long list. The ... button next to Refresh manages remotes and tags; the download arrow fetches.",
    keywords:
      "branch rename delete merge remote origin url tag fetch prune checkout tracking clone all branches filter search long list scroll more entries",
  },
  {
    id: "git-commit-view",
    section: "Git",
    title: "Reading a commit",
    body: "Click a commit in History to see its message and changed files; click a file to see its patch.",
    keywords:
      "commit history file list changed files patch diff show rename binary added modified deleted lines author message",
  },
  {
    id: "git-history-ops",
    section: "Git",
    title: "Undoing and moving commits",
    body: "Right-click a commit in History to copy its id, revert it, cherry-pick it or reset to it. Reset can keep the changes staged, keep them unstaged, or discard them (this cannot be undone).",
    keywords: "revert undo cherry-pick reset soft mixed hard rollback commit id sha",
  },
  {
    id: "git-conflicts",
    section: "Git",
    title: "Resolve merge conflicts",
    body: "Conflicted files appear under Merge conflicts; click Resolve. For each conflict keep ours, theirs or both, edit by hand, or let AI merge it. Save & mark resolved unlocks once every conflict has a decision.",
    keywords: "merge conflict resolve ours theirs ai rebase pull markers",
  },
  {
    id: "git-blame-branch",
    section: "Git",
    title: "Blame & branches",
    body: "The line under the cursor shows who last changed it and when. Click the branch name in the Git panel to switch or create a branch.",
    keywords: "blame author annotate branch checkout switch create",
  },
  {
    id: "git-stash-amend",
    section: "Git",
    title: "Stash & amend",
    body: "The archive button in the Changes header stashes everything; each stash offers Pop, Apply and Delete. The Amend checkbox next to Commit rewrites the last commit (an empty message keeps the old one).",
    keywords: "stash save shelve amend rewrite last commit wip",
  },
  {
    id: "git-multiselect",
    section: "Git",
    title: "Select multiple changes",
    body: "In the change lists, Ctrl+click and Shift+click select several files; right-click to stage, unstage, discard or add them to .gitignore. In the file tree, right-click can also ignore a folder, or Stop tracking and ignore a tracked file (the file stays on disk).",
    keywords:
      "multi select ctrl shift right click context menu bulk gitignore folder tree untrack stop tracking rm cached",
  },
  {
    id: "terminal",
    section: "Terminal",
    title: "Integrated terminal",
    body: "Ctrl+` toggles a terminal in the project root (PowerShell on Windows, your default shell on macOS and Linux). + opens more tabs. Right-click copies the selection, or pastes when nothing is selected.",
    keywords: "shell powershell tabs console",
  },
  {
    id: "task-run",
    section: "Work items",
    title: "Hand a work item over and walk away",
    body: "'Work on this with AI' on a work item hands the whole task to the AI. The run creates its own branch and checkpoint, turns the ticket into test cases (.aime/test-cases.md; edit .aime/test-cases.json to change them) and stops at the plan for your approval ('Run to the end' skips that stop). It then writes the code and tests, runs your project's tests and checks and fixes failures, gets an independent AI review, and, when a screen or service changed, runs the app locally to prove each case. It follows your project's rules files (AGENTS.md, CLAUDE.md…), never deploys to a real cloud or production, and cleans up what it installed. You get a branch, a table of which cases were proved, evidence in .aime/evidence/, a report in .aime/runs/, and one button to undo everything. A paused run resumes with Carry on. 'Task runs' in the command palette lists past runs. Several runs can work at once, each in its own worktree.",
    keywords:
      "task run work with ai agent autonomous automate steps acceptance criteria test case given when then plan review security owasp architecture rules AGENTS.md CLAUDE.md branch checkpoint undo evidence report resume carry on cleanup worktree unattended",
  },
  {
    id: "work-items",
    section: "Work items",
    title: "Connect a board (Azure DevOps, Jira, ClickUp, GitHub)",
    body: "The checklist tab in the sidebar shows work assigned to you from Azure DevOps, Jira (Cloud or Server / Data Center), ClickUp or GitHub. Connect with the service's details and an access token; the token is stored on this machine only, never in the repository. Each project remembers its board. Mine / All chooses whose work to load, the filter box searches titles and ids, and 'Include finished work' shows closed items. Click an item to read it, comment or change its state; a row can also open it in the browser, create a branch, or start 'Work on this with AI'. If a token expires, press Reconnect; the … menu switches or removes the board.",
    keywords:
      "azure devops jira clickup github board work item issue task backlog sprint token branch state comment assigned to me filter mine all reconnect",
  },
  {
    id: "tasks",
    section: "Tasks",
    title: "Run, build and test",
    body: "The play button in the status bar lists run, build, test, check and publish for this project. Common stacks are detected automatically; for others the AI suggests commands, which Aime tests before keeping. Each task runs in its own terminal tab. Add or override tasks in .aime/tasks.json.",
    keywords:
      "task run build test check lint typecheck clippy publish npm pnpm yarn bun workspace monorepo cargo dotnet go pytest docker tasks.json e2e watch",
  },
  {
    id: "tasks-fix",
    section: "Tasks",
    title: "Fix a failure with AI",
    body: "When a task fails, a red bar appears above the terminal. Fix with AI sends the output to the AI to find and fix the cause.",
    keywords: "fix error failure build failed exit code ai repair",
  },
  {
    id: "ai-setup",
    section: "Editor",
    title: "Open a language Aime does not support yet",
    body: "When the open file's language is missing a language server or debugger, a bar appears at the top of the editor. Install it runs the known install command; Let AI set it up lets the AI install what this machine needs, in its own window, asking before licences, large downloads or administrator rights.",
    keywords: "unsupported language install setup ai automatic toolchain missing server debugger",
  },
  {
    id: "debug",
    section: "Debug",
    title: "Run a program with breakpoints",
    body: "Press F5 to start debugging, or use Run and Debug (the bug tab in the sidebar). F9 or a click left of a line number sets a breakpoint. F10 step over, F11 step into, Shift+F11 step out, F5 continue, Shift+F5 stop. While paused, the sidebar shows the call stack and variables. F5 runs the project's main program; pick another under Target. Shift+F9 adds a condition, hit count or log message to a breakpoint. Arguments sets the build command, command line and environment (saved in .aime/launch.json). 'Attach to a running program…' connects to a process started with node --inspect or debugpy --listen.",
    keywords: "debug breakpoint step f5 f9 f10 f11 call stack variables pause continue build solution",
  },
  {
    id: "debug-adapters",
    section: "Debug",
    title: "What Aime can debug",
    body: "Supported: JavaScript and TypeScript, Python, Go, C# and F#. A missing debugger is downloaded with Download it, or the panel shows its install command. For other languages, Let AI set it up in Run and Debug installs and tests a debugger; the language is enabled only if the test stops at a breakpoint.",
    keywords:
      "js-debug debugpy delve netcoredbg go python node typescript csharp dotnet adapter download install build",
  },
  {
    id: "debug-console",
    section: "Debug",
    title: "The Debug Console",
    body: "The Debug Console in the bottom panel shows the program's output (errors in red) and its exit code. While paused, type an expression at the bottom to evaluate it; ↑ recalls earlier ones.",
    keywords: "console output stdout stderr exit code print evaluate repl expression watch",
  },
  {
    id: "debug-breakpoint-moves",
    section: "Debug",
    title: "Why a breakpoint moved",
    body: "A breakpoint on a line that cannot run (a blank line, a closing brace) moves to the nearest line that can. If the debugger rejects a line, the dot turns amber; hover it for the reason.",
    keywords: "breakpoint moved line verified wrong place persist amber refused",
  },
  {
    id: "error-log",
    section: "UI & shortcuts",
    title: "When something breaks",
    body: "Errors are written to a local log file (open it from Settings), and a failed action shows a short notice above the status bar. Nothing is sent anywhere.",
    keywords: "error log crash report diagnostics privacy blank window",
  },
  {
    id: "updates",
    section: "UI & shortcuts",
    title: "Updates and channels",
    body: "Settings offers two update channels: Stable (releases only) and Beta (pre-releases too). An update installs only when you press Update now, and its signature is checked first.",
    keywords: "update upgrade version beta channel stable install signature",
  },
  {
    id: "settings",
    section: "UI & shortcuts",
    title: "Settings",
    body: "Ctrl+, or the gear in the status bar opens Settings: theme, language, font size, word wrap, indentation, auto save, AI CLI, model and permissions. Changes apply immediately.",
    keywords: "settings preferences options font size word wrap theme language ctrl+,",
  },
  {
    id: "transfer",
    section: "UI & shortcuts",
    title: "Changing machines",
    body: "Settings > Advanced > Take to another machine exports chat history, AI memory and CLI transcripts into one zip. On the new machine, use Receive from another machine; each project's history is restored when you open it there. This is a one-time move, not a sync.",
    keywords: "transfer export import new laptop machine move migrate backup chat history memory resume",
  },
  {
    id: "flows",
    section: "AI",
    title: "Flows",
    body: "A flow is a pipeline of steps you draw on a canvas and run when needed. Flows in the sidebar lists this project's flows (stored in .aime/flows), My flows, Templates and Connections. Create one by describing it and pressing Draw, or add steps from the palette (AI turn, command, condition, HTTP API, git / PR, mail, files and more). Drag from a step's right port to the next step's left port to connect them; right-click for more actions; Ctrl+Z / Ctrl+Y undo and redo. Use {{step.value.field}} to pass an earlier result. Try this step runs one step; Run… takes any input (text, files, a ticket), and Preview runs without changing anything. If a step fails, Ask the AI what went wrong suggests a fix. History lists past runs, and an interrupted run can Carry on. Secrets ({{secret.NAME}}) are kept in the OS keychain.",
    keywords:
      "flows flow workflow pipeline canvas steps wires automation run draw template secret connection preview history carry on undo redo shortcuts",
  },
  {
    id: "ai-composer",
    section: "AI",
    title: "Pointing the AI at the right thing",
    body: "Type @ in the chat box to mention a file. Paste a screenshot with Ctrl+V to attach it. In an empty chat, suggested prompts appear above the box.",
    keywords: "@ mention file picker path suggestions starter empty chat composer",
  },
  {
    id: "inline-ai",
    section: "AI",
    title: "Suggestions at the cursor",
    body: "Ctrl+Alt+Space asks the AI to complete the current line or block; Tab accepts, Esc dismisses. The chip in the status bar switches between On ask (default), Auto and Off. Each suggestion takes a few seconds and uses tokens; Ctrl+Space gives the language server's instant completions.",
    keywords: "ghost text inline completion suggestion ctrl+alt+space autocomplete ai copilot",
  },
  {
    id: "ai-actions",
    section: "AI",
    title: "Ask about the code you are looking at",
    body: "Select code, right-click, and choose explain, clean up, write tests, fix bugs or add comments. With nothing selected the whole file is used. Undo this turn reverts any changes.",
    keywords: "explain refactor tests fix comments right-click selection context menu ai",
  },
  {
    id: "palette",
    section: "UI & shortcuts",
    title: "Command palette",
    body: "Ctrl+K (or Ctrl+P) searches commands and files; start with '>' for commands only. Enter runs or opens, Esc closes.",
    keywords: "quick open search jump command ctrl+k ctrl+p fuzzy",
  },
  {
    id: "panels",
    section: "UI & shortcuts",
    title: "Panels",
    body: "Drag the dividers to resize; drag a panel below its minimum to collapse it. Ctrl+B file tree, Ctrl+L AI panel, Ctrl+` terminal.",
    keywords: "layout sidebar resize collapse rail",
  },
  {
    id: "theme-lang",
    section: "UI & shortcuts",
    title: "Theme & language",
    body: "In the status bar: the sun/moon button switches dark/light mode, EN/VI switches the interface language.",
    keywords: "dark light vietnamese english",
  },
  {
    id: "shortcuts",
    section: "UI & shortcuts",
    title: "All shortcuts",
    body: "Ctrl+K/Ctrl+P command palette · Ctrl+S save · Ctrl+W close tab · Ctrl+, settings · Ctrl+B file tree · Ctrl+L AI panel · Ctrl+` terminal · Ctrl+Shift+N new window · F5 debug · F12 go to definition · Ctrl+Alt+Space AI suggestion · F1 this help.",
    keywords: "keyboard hotkeys keys",
  },
];

const VI: HelpTopic[] = [
  {
    id: "open-project",
    section: "Bắt đầu",
    title: "Mở dự án",
    body: "Ở màn hình chào: Mở thư mục, Gần đây (8 workspace gần nhất; x để gỡ khỏi danh sách), Dự án mới, và Clone repository (clone một git URL rồi mở). Dòng ở cuối cho biết AI CLI, Git, Node và language server đã sẵn sàng chưa; bấm vào để xem cách xử lý phần còn thiếu.",
    keywords: "workspace recent folder mở thư mục logo",
  },
  {
    id: "updates",
    section: "Bắt đầu",
    title: "Cập nhật",
    body: "Mỗi lần mở app, Aime kiểm tra bản mới và hiện một thanh thông báo nếu có. Không tải gì cho tới khi anh bấm Cập nhật ngay. Bản cập nhật có ký số; bản không có chữ ký hợp lệ bị từ chối.",
    keywords: "cập nhật update phiên bản release ký số",
  },
  {
    id: "splash",
    section: "Bắt đầu",
    title: "Cửa sổ khởi động",
    body: "Một thẻ khởi động ngắn hiện ra trong lúc nạp dự án. Bấm phím bất kỳ hoặc click để bỏ qua, hoặc tắt 'Cửa sổ khởi động' trong Cài đặt.",
    keywords: "splash khởi động màn hình chào logo bỏ qua đang tải hoạt hình",
  },
  {
    id: "cli",
    section: "Bắt đầu",
    title: "Mở từ terminal",
    body: "Gõ `aime .` trong terminal để mở thư mục hiện hành, hoặc `aime <đường dẫn>` cho thư mục khác. App đang chạy sẽ được dùng lại.",
    keywords: "command line launcher dòng lệnh",
  },
  {
    id: "multi-window",
    section: "Bắt đầu",
    title: "Nhiều dự án song song",
    body: "Ctrl+Shift+N, nút cửa sổ trên status bar, hoặc Cửa sổ mới ở màn hình chào mở một cửa sổ riêng với dự án, AI chat và terminal riêng.",
    keywords: "cửa sổ mới new window",
  },
  {
    id: "switch-close",
    section: "Workspace",
    title: "Đổi hoặc đóng workspace",
    body: "Rê chuột vào tên dự án trên cây file: icon thư mục để mở workspace khác, X để đóng. Mở lại workspace là thấy như lúc rời đi, gồm các tab, vị trí con trỏ và phần chưa lưu. Nếu file trên đĩa đã đổi trong lúc đó, chọn Giữ bản của tôi hoặc lấy bản trên đĩa. Terminal, phiên gỡ lỗi và task đang chạy không được khôi phục.",
    keywords: "đóng thư mục quay lại close folder mở lại khôi phục tab chưa lưu phiên",
  },
  {
    id: "file-tree",
    section: "Workspace",
    title: "Cây file",
    body: "Click để mở file. Chuột phải có Mở, Mở trong File Explorer, Git Blame, Tạo file, Tạo thư mục, Đổi tên và Xóa. Kéo thả để chuyển vào thư mục, ra cạnh một file, hoặc về gốc (thả lên tên dự án). Thao tác nào lỗi thì lý do hiện ở đầu cây file.",
    keywords: "kéo thả di chuyển tạo xóa đổi tên drag drop reveal explorer blame lỗi",
  },
  {
    id: "live-updates",
    section: "Workspace",
    title: "Cập nhật trực tiếp",
    body: "Thay đổi từ bên ngoài editor, kể cả do AI sửa, tự hiện trong cây file và file đang mở.",
    keywords: "watcher tự động refresh gitignore bỏ qua lag chậm",
  },
  {
    id: "editor",
    section: "Editor",
    title: "Soạn thảo & lưu",
    body: "Mỗi thư mục đang mở là một tab trên dải đầu cửa sổ: + để mở thêm, kéo để đổi thứ tự, chuột phải để tách ra cửa sổ riêng. Workspace ở phía sau vẫn chạy tiếp. Mỗi file mở trong một tab; dấu chấm là còn thay đổi chưa lưu, Ctrl+W để đóng, chuột phải có Đóng các tab khác, Đóng tab đã lưu, Chép đường dẫn và các lệnh khác. Ctrl+S để lưu; tự động lưu (bật sẵn, xem Cài đặt) lưu sau một giây kể từ lúc ngừng gõ. File .csv/.tsv mở thành bảng, .md hiển thị như trang tài liệu, .json/.xml thành cây; nút Chữ để xem văn bản gốc. Với .html, nút Xem hiện trang web.",
    keywords:
      "lưu save dirty undo sticky scroll outline ghim symbol csv tsv bảng table markdown xem trước json xml cây",
  },
  {
    id: "encoding",
    section: "Editor",
    title: "File có dấu BOM ở đầu",
    body: "File có dấu BOM UTF-8 được mở với dấu đó ẩn đi và vẫn giữ khi lưu, nên mở rồi lưu không tạo thay đổi trong git.",
    keywords: "bom dấu thứ tự byte utf-8 encoding visual studio c# diff patch ký tự lạ",
  },
  {
    id: "lsp",
    section: "Editor",
    title: "Code intelligence (gợi ý, kiểu, nhảy tới định nghĩa)",
    body: "Gợi ý code, thông tin khi rê chuột, F12 hoặc Ctrl+click (tới định nghĩa), Ctrl+F12 (chỗ hiện thực), Shift+F12 (tham chiếu), F2 (đổi tên toàn dự án) và báo lỗi khi gõ đến từ chính các language server mà VS Code dùng. TypeScript, JavaScript, HTML, CSS và JSON dùng được ngay; server cho Python, PHP, SQL, shell, YAML và Dockerfile (cùng Go và Rust nếu máy có toolchain) tự cài. Với ngôn ngữ khác, mở file sẽ được đề nghị cài server (C# khoảng 65 MB; Java khoảng 45 MB và cần JDK 17 trở lên). Chip ngôn ngữ trên status bar: xanh = đang chạy, vàng = còn thiếu (tooltip có lệnh cài), xoay = đang nạp.",
    keywords:
      "lsp intellisense gợi ý autocomplete hover định nghĩa cài đặt implementation chỗ dùng references f12 lỗi chẩn đoán gopls pyright rust-analyzer",
  },
  {
    id: "plugins",
    section: "Editor",
    title: "Plugin",
    body: "Plugin là một thư mục gồm plugin.json và một script, đặt trong thư mục plugin của Aime (mở từ Cài đặt). Bật plugin trong Cài đặt; nó chạy trong sandbox, chỉ có các quyền đã khai báo và thêm lệnh vào command palette. Plugin bị treo hoặc chạy bất thường sẽ bị dừng. Plugin không bao giờ được nạp từ dự án.",
    keywords: "plugin tiện ích api sandbox worker quyền lệnh",
  },
  {
    id: "ai-requirements",
    section: "AI",
    title: "AI cần gì (và không có AI vẫn dùng được gì)",
    body: "AI cần một AI CLI trên máy: Claude Code (npm install -g @anthropic-ai/claude-code) hoặc Codex (npm install -g @openai/codex). Khi cần, Aime hiện lệnh cài hoặc nút đăng nhập. Không có AI thì mọi tính năng khác vẫn dùng bình thường.",
    keywords: "cài đặt đăng nhập login yêu cầu offline thủ công không có ai codex claude",
  },
  {
    id: "ai-provider",
    section: "AI",
    title: "Chọn AI CLI & đăng nhập",
    body: "Chip đầu tiên trên đầu panel AI để chọn AI CLI; đổi CLI là bắt đầu phiên mới. Nút chìa khoá bên cạnh đăng nhập bằng lệnh login của chính CLI trong một tab terminal. Phiên đăng nhập hết hạn thì bấm Đăng nhập lại, rồi Tiếp tục. Muốn dùng API key thì vào Cài đặt > AI > API key; key chỉ lưu trên máy này (với Codex, key sẽ thay tài khoản đang đăng nhập nên Aime hỏi trước).",
    keywords: "provider đổi codex claude đăng nhập login chìa khóa tài khoản api key anthropic token",
  },
  {
    id: "ai-add-provider",
    section: "AI",
    title: "Dùng AI CLI khác",
    body: "Muốn thêm AI CLI khác (ví dụ Gemini): Cài đặt > AI > Thêm AI CLI, nhập tên CLI, AI sẽ tự viết cấu hình. Hoặc tự sửa providers.json: 'Thêm AI CLI' trong command palette mở file này kèm ví dụ. Sửa xong có hiệu lực ngay. Trên Windows, CLI cài bằng npm cần promptStdin: true.",
    keywords: "providers.json generic adapter gemini cli tùy chỉnh thêm provider nạp lại khởi động",
  },
  {
    id: "ai-chat",
    section: "AI",
    title: "Chat với AI",
    body: "Gõ prompt rồi Enter (Shift+Enter để xuống dòng). AI đọc, sửa dự án và chạy lệnh; các bước hiện thành chip bấm vào để xem. AI tự thấy file đang mở, đoạn đang chọn và những gì đang hiện trên màn hình. Dòng dưới khung chat cho biết AI đang làm gì, cuối mỗi lượt có chi phí và thời gian. Dừng để huỷ lượt; Tiếp tục để chạy tiếp lượt bị ngắt. Có thể gửi thêm tin trong lúc AI làm: tin xếp hàng chờ, có thể rút lại (x), sửa (bút chì) hoặc gửi ngay (mũi tên). Tên file và thư mục trong câu trả lời bấm vào được.",
    keywords:
      "prompt gửi agent tool bước subagent chạy nền dừng tiếp tục bị ngắt hàng chờ xếp hàng rút lại sửa gửi ngay link đường dẫn mở file thư mục",
  },
  {
    id: "ai-model",
    section: "AI",
    title: "Model & effort",
    body: "Các chip phía trên khung chat chọn model và mức effort. Danh sách model lấy từ CLI đã cài, nên model mới tự có. Auto dùng mặc định của CLI và ghi rõ đó là gì.",
    keywords: "opus sonnet haiku fable gpt codex gemini phiên bản effort ultra danh mục liệt kê",
  },
  {
    id: "ai-approve",
    section: "AI",
    title: "AI được làm tới đâu (quyền)",
    body: "Chip khiên đặt mức AI được làm: TOÀN QUYỀN (làm mọi thứ, không hỏi), SỬA FILE (sửa file; lệnh chỉ chạy trong phạm vi luật của CLI) hoặc CHỈ ĐỌC (đọc và giải thích, không thay đổi gì).",
    keywords: "permission quyền sandbox chỉ đọc an toàn khiên",
  },
  {
    id: "ai-usage",
    section: "AI",
    title: "Mức dùng & chi phí",
    body: "Nút activity phía trên khung chat hiện số token của phiên, kèm chi phí nếu CLI có báo (Claude Code có; Codex chỉ hiện token).",
    keywords: "token chi phí tiền usage thuê bao",
  },
  {
    id: "ai-undo",
    section: "AI",
    title: "Lấy lại một lượt AI",
    body: "Dưới mỗi câu trả lời có sửa file, Hoàn tác lượt này đưa các file về như trước lúc anh gửi tin và xoá file AI tạo ra. Phần anh đã stage vẫn được giữ. Cần có git.",
    keywords: "hoàn tác undo rollback checkpoint sai an toàn ai sửa file",
  },
  {
    id: "ai-sessions",
    section: "AI",
    title: "Phiên & bộ nhớ",
    body: "Chat được lưu theo dự án và tiếp tục được sau khi khởi động lại. Nút lịch sử liệt kê 20 phiên gần nhất, + để mở phiên mới, bút chì để đổi tên phiên. Aime ghi chú trong thư mục .aime/, git tự bỏ qua thư mục này.",
    keywords: "resume lịch sử khôi phục ngữ cảnh nhớ tiến độ gitignore commit",
  },
  {
    id: "cloud",
    section: "AI",
    title: "Panel cloud và deploy",
    body: "Nút cloud trên status bar mở panel cloud: Azure, AWS, Google Cloud và Supabase là các tab, cột trái là các tài khoản mà CLI của từng cloud đang đăng nhập. Chọn một tài khoản để xem Resource, hoặc Ứng dụng dưới dạng sơ đồ. Bấm vào resource để xem Tổng quan, Kết nối (endpoint để copy), Triển khai cùng và JSON gốc; secret chỉ được đọc khi anh bấm Hiện và không bao giờ gửi cho AI. 'Làm được gì với cái này' chạy các thao tác thường dùng như xem log, restart hay scale; thao tác thay đổi luôn hiện lệnh trước, muốn xoá phải gõ đúng tên resource. Nút Deploy trên đầu tài khoản deploy dự án đang mở: AI viết kế hoạch, trang xác nhận liệt kê mọi lệnh và file, chưa bấm Deploy thì chưa có gì chạy. Các lần deploy được lưu trong .aime/deploy/history. Đăng nhập ngay trong panel hoặc ở terminal bất kỳ. Ghi vào bộ nhớ AI lưu những gì đang chạy trong tài khoản vào AGENTS.md để AI nắm được.",
    keywords:
      "cloud azure aws gcp google supabase kết nối đăng nhập cli account subscription project resource ứng dụng sơ đồ endpoint secret thao tác deploy lịch sử bộ nhớ agents.md",
  },
  {
    id: "mcp",
    section: "AI",
    title: "MCP server (plugin cho AI)",
    body: "Nút phích cắm trên đầu panel AI (hoặc 'MCP server…' trong command palette) quản lý MCP server, các công cụ thêm cho AI. 'Duyệt & tìm server' liệt kê server phổ biến và tìm trong registry chính thức; cũng có thể tự nhập URL hoặc lệnh. Claude Code lưu server theo dự án, Codex lưu chung.",
    keywords: "mcp plugin tool server thêm xoá connector github notion",
  },
  {
    id: "git",
    section: "Git",
    title: "Panel Git",
    body: "Tab Git ở thanh bên hiện các thay đổi: stage, unstage, bỏ thay đổi, commit (Ctrl+Enter), push và pull. Chưa stage gì mà commit thì stage hết. Bấm vào file để xem diff (Một cột để xem một cột). Lịch sử liệt kê các commit. Cây file và lề editor đánh dấu chỗ thay đổi. Nút lấp lánh nhờ AI viết commit message.",
    keywords: "commit stage diff push pull nhánh branch quản lý phiên bản init",
  },
  {
    id: "git-repositories",
    section: "Git",
    title: "Nhiều repo trong một thư mục",
    body: "Thư mục chứa nhiều repo (ví dụ frontend và backend) thì panel Git có mỗi repo một chip; bấm vào để làm việc với repo đó. Mở một file là tự chuyển sang repo của file. Thư mục chưa có git thì có nút Khởi tạo repository.",
    keywords: "nhiều repo monorepo multi-repo frontend backend thư mục cha thư mục con chuyển repo chip",
  },
  {
    id: "git-review",
    section: "Git",
    title: "Nhờ AI soát lại trước khi commit",
    body: "Nút Soát lại cạnh Commit nhờ AI xem phần sắp commit. Vấn đề đánh dấu ! đỏ, nhận xét nhỏ đánh dấu chấm; bấm vào để mở file. Nó không bao giờ chặn commit.",
    keywords: "review soát lại ai trước commit nhận xét vấn đề",
  },
  {
    id: "git-branches",
    section: "Git",
    title: "Nhánh, remote và tag",
    body: "Bấm tên nhánh để chuyển, tạo, đổi tên, merge hoặc xoá nhánh; danh sách có cả nhánh remote, chọn là checkout luôn. Danh sách dài thì gõ để lọc. Nút ... cạnh Làm mới quản lý remote và tag; mũi tên tải xuống để fetch.",
    keywords:
      "nhánh đổi tên xoá merge remote origin url tag fetch checkout theo dõi clone toàn bộ nhánh lọc tìm danh sách dài cuộn còn bao nhiêu",
  },
  {
    id: "git-commit-view",
    section: "Git",
    title: "Đọc một commit",
    body: "Bấm một commit trong Lịch sử để xem message và các file đã đổi; bấm vào file để xem patch.",
    keywords:
      "commit lịch sử danh sách file thay đổi diff patch đổi tên nhị phân thêm sửa xoá số dòng tác giả message",
  },
  {
    id: "git-history-ops",
    section: "Git",
    title: "Hoàn tác và di chuyển commit",
    body: "Chuột phải vào commit trong Lịch sử để chép mã, revert, cherry-pick hoặc reset về commit đó. Reset có thể giữ thay đổi ở vùng stage, giữ nhưng chưa stage, hoặc bỏ hẳn (không hoàn tác được).",
    keywords: "revert hoàn tác cherry-pick reset soft mixed hard commit sha",
  },
  {
    id: "git-conflicts",
    section: "Git",
    title: "Giải quyết xung đột merge",
    body: "File bị xung đột hiện trong Xung đột merge; bấm Giải quyết. Với mỗi xung đột: giữ bên mình, bên kia hoặc cả hai, tự sửa, hoặc để AI hoà giải. Lưu & đánh dấu đã giải mở khoá khi mọi xung đột đã có quyết định.",
    keywords: "merge conflict xung đột giải quyết ours theirs ai rebase pull",
  },
  {
    id: "git-blame-branch",
    section: "Git",
    title: "Blame & nhánh",
    body: "Dòng đang đặt con trỏ hiện ai sửa nó lần cuối và khi nào. Bấm tên nhánh trong panel Git để chuyển hoặc tạo nhánh.",
    keywords: "blame tác giả nhánh branch checkout chuyển tạo",
  },
  {
    id: "git-stash-amend",
    section: "Git",
    title: "Stash & amend",
    body: "Nút lưu trữ trên đầu khu Thay đổi stash toàn bộ; mỗi stash có Pop, Áp dụng và Xóa. Ô Amend cạnh Commit sửa lại commit cuối (để trống message là giữ message cũ).",
    keywords: "stash cất tạm amend sửa commit cuối wip",
  },
  {
    id: "git-multiselect",
    section: "Git",
    title: "Chọn nhiều thay đổi",
    body: "Trong danh sách thay đổi, Ctrl+click và Shift+click để chọn nhiều file; chuột phải để stage, unstage, bỏ thay đổi hoặc thêm vào .gitignore. Trong cây file, chuột phải còn ignore được cả thư mục, hoặc Ngừng theo dõi và bỏ qua một file đã track (file vẫn nằm trên đĩa).",
    keywords:
      "chọn nhiều ctrl shift chuột phải menu hàng loạt gitignore thư mục cây file ngừng theo dõi untrack",
  },
  {
    id: "terminal",
    section: "Terminal",
    title: "Terminal tích hợp",
    body: "Ctrl+` bật/tắt terminal tại thư mục gốc dự án (PowerShell trên Windows, shell mặc định trên macOS và Linux). + để mở thêm tab. Chuột phải để copy phần đang chọn, hoặc dán khi không chọn gì.",
    keywords: "shell powershell tab console",
  },
  {
    id: "task-run",
    section: "Công việc",
    title: "Giao một việc rồi đi chỗ khác",
    body: "Nút 'Làm việc này cùng AI' trên một work item giao trọn việc cho AI. Lượt chạy tạo nhánh và checkpoint riêng, chuyển ticket thành test case (.aime/test-cases.md; sửa .aime/test-cases.json để đổi) rồi dừng ở bước kế hoạch chờ anh duyệt ('Chạy tới hết' để bỏ qua điểm dừng này). Sau đó nó viết code và test, chạy test và check của dự án rồi sửa lỗi, nhờ một AI khác review, và nếu có đổi màn hình hay dịch vụ thì chạy app trên máy để chứng minh từng case. Nó tuân theo file quy tắc của dự án (AGENTS.md, CLAUDE.md…), không bao giờ deploy lên cloud thật hay production, và tự dọn những gì đã cài. Kết quả là một nhánh, bảng cho biết case nào đã được chứng minh, bằng chứng trong .aime/evidence/, báo cáo trong .aime/runs/, và một nút hoàn tác toàn bộ. Lượt chạy bị tạm dừng thì bấm Chạy tiếp. 'Các lượt AI làm việc' trong command palette liệt kê các lượt trước. Có thể chạy nhiều lượt cùng lúc, mỗi lượt trong một worktree riêng.",
    keywords:
      "lượt làm việc task run làm việc cùng ai agent tự động tiêu chí nghiệm thu test case given when then kế hoạch review bảo mật owasp kiến trúc luật dự án AGENTS.md CLAUDE.md nhánh checkpoint hoàn tác bằng chứng báo cáo chạy tiếp dọn dẹp worktree",
  },
  {
    id: "work-items",
    section: "Công việc",
    title: "Kết nối bảng công việc (Azure DevOps, Jira, ClickUp, GitHub)",
    body: "Tab checklist ở thanh bên hiện việc được giao cho anh từ Azure DevOps, Jira (Cloud hoặc Server / Data Center), ClickUp hoặc GitHub. Kết nối bằng thông tin của dịch vụ và một access token; token chỉ lưu trên máy này, không bao giờ nằm trong repo. Mỗi dự án nhớ board của nó. Của tôi / Tất cả chọn tải việc của ai, ô lọc tìm theo tiêu đề và mã, 'Hiện cả việc đã xong' để xem cả việc đã đóng. Bấm vào một item để đọc, bình luận hoặc đổi trạng thái; trên mỗi dòng còn có thể mở trong trình duyệt, tạo nhánh, hoặc bắt đầu 'Làm việc này cùng AI'. Token hết hạn thì bấm Kết nối lại; menu … để đổi hoặc gỡ board.",
    keywords:
      "azure devops jira clickup github bảng công việc work item task backlog sprint token nhánh trạng thái bình luận giao cho tôi lọc kết nối lại",
  },
  {
    id: "tasks",
    section: "Task",
    title: "Chạy, build và test",
    body: "Nút play trên status bar liệt kê run, build, test, check và publish của dự án. Các stack phổ biến được nhận ra tự động; loại khác thì AI đề xuất lệnh, Aime chạy thử rồi mới giữ lại. Mỗi task chạy trong một tab terminal riêng. Thêm hoặc ghi đè task trong .aime/tasks.json.",
    keywords:
      "task chạy build test kiểm lint typecheck clippy publish npm pnpm yarn bun workspace monorepo cargo dotnet go pytest docker tasks.json e2e watch",
  },
  {
    id: "tasks-fix",
    section: "Task",
    title: "Nhờ AI sửa khi task lỗi",
    body: "Khi task lỗi, một thanh đỏ hiện phía trên terminal. Nhờ AI sửa gửi output cho AI để tìm và sửa nguyên nhân.",
    keywords: "sửa lỗi build fail exit code ai khắc phục",
  },
  {
    id: "ai-setup",
    section: "Editor",
    title: "Mở ngôn ngữ Aime chưa hỗ trợ sẵn",
    body: "Khi ngôn ngữ của file đang mở thiếu language server hoặc debugger, một thanh hiện trên đầu editor. Cài ngay chạy lệnh cài đã biết; Để AI lo giao cho AI cài những gì máy cần, trong cửa sổ riêng, có hỏi trước khi gặp giấy phép, bản tải lớn hoặc quyền admin.",
    keywords: "chưa hỗ trợ ngôn ngữ cài đặt ai tự động toolchain thiếu server gỡ lỗi",
  },
  {
    id: "debug",
    section: "Gỡ lỗi",
    title: "Chạy chương trình với điểm dừng",
    body: "Bấm F5 để bắt đầu gỡ lỗi, hoặc dùng Chạy và gỡ lỗi (tab con bọ ở thanh bên). F9 hoặc click bên trái số dòng để đặt điểm dừng. F10 bước qua, F11 bước vào, Shift+F11 bước ra, F5 chạy tiếp, Shift+F5 dừng. Khi đang dừng, thanh bên hiện ngăn xếp lời gọi và các biến. F5 chạy chương trình chính của dự án; chọn chương trình khác ở mục Chạy. Shift+F9 thêm điều kiện, số lần chạm hoặc thông điệp log cho điểm dừng. Tham số đặt lệnh build, dòng lệnh và biến môi trường (lưu trong .aime/launch.json). 'Gắn vào chương trình đang chạy…' kết nối tới tiến trình chạy bằng node --inspect hoặc debugpy --listen.",
    keywords: "gỡ lỗi debug điểm dừng breakpoint bước f5 f9 f10 f11 ngăn xếp biến build solution",
  },
  {
    id: "debug-adapters",
    section: "Gỡ lỗi",
    title: "Aime gỡ lỗi được những gì",
    body: "Hỗ trợ: JavaScript và TypeScript, Python, Go, C# và F#. Thiếu debugger thì bấm Tải về, hoặc panel hiện lệnh cài. Với ngôn ngữ khác, Để AI lo trong Chạy và gỡ lỗi sẽ cài và thử debugger; ngôn ngữ chỉ được bật khi lần thử dừng được ở điểm dừng.",
    keywords:
      "js-debug debugpy delve netcoredbg go python node typescript csharp dotnet adapter tải cài build",
  },
  {
    id: "debug-console",
    section: "Gỡ lỗi",
    title: "Bảng điều khiển gỡ lỗi",
    body: "Bảng điều khiển gỡ lỗi ở panel dưới hiện output của chương trình (lỗi màu đỏ) và mã thoát. Khi đang dừng, gõ biểu thức ở dòng cuối để tính; ↑ để gọi lại biểu thức đã gõ.",
    keywords: "console output stdout stderr mã lỗi in biểu thức repl evaluate",
  },
  {
    id: "debug-breakpoint-moves",
    section: "Gỡ lỗi",
    title: "Vì sao điểm dừng bị dời chỗ",
    body: "Điểm dừng đặt ở dòng không chạy được (dòng trống, dấu đóng ngoặc) sẽ dời sang dòng chạy được gần nhất. Nếu debugger từ chối dòng đó, chấm chuyển vàng; rê chuột vào để xem lý do.",
    keywords: "điểm dừng dời dòng verified sai chỗ ghi nhớ màu vàng từ chối",
  },
  {
    id: "error-log",
    section: "Giao diện & phím tắt",
    title: "Khi có gì đó hỏng",
    body: "Lỗi được ghi vào file log trên máy (mở từ Cài đặt), và thao tác thất bại hiện một thông báo ngắn phía trên status bar. Không có gì được gửi ra ngoài.",
    keywords: "nhật ký lỗi crash báo lỗi chẩn đoán riêng tư màn hình trắng",
  },
  {
    id: "updates",
    section: "Giao diện & phím tắt",
    title: "Cập nhật và kênh phát hành",
    body: "Cài đặt có hai kênh cập nhật: Ổn định (chỉ bản chính thức) và Thử nghiệm (nhận cả bản pre-release). Bản cập nhật chỉ được cài khi anh bấm Cập nhật ngay, và chữ ký được kiểm trước.",
    keywords: "cập nhật phiên bản beta kênh ổn định cài chữ ký",
  },
  {
    id: "settings",
    section: "Giao diện & phím tắt",
    title: "Cài đặt",
    body: "Ctrl+, hoặc nút bánh răng trên status bar mở Cài đặt: theme, ngôn ngữ, cỡ chữ, xuống dòng, thụt lề, tự động lưu, AI CLI, model và quyền của AI. Thay đổi có hiệu lực ngay.",
    keywords: "cài đặt tuỳ chọn cỡ chữ xuống dòng theme ngôn ngữ ctrl+,",
  },
  {
    id: "transfer",
    section: "Giao diện & phím tắt",
    title: "Đổi máy",
    body: "Cài đặt > Nâng cao > Mang sang máy khác xuất lịch sử chat, bộ nhớ AI và transcript của CLI vào một file zip. Ở máy mới, dùng Nhận từ máy khác; lịch sử của từng dự án được khôi phục khi anh mở dự án đó. Đây là chuyển một lần, không phải đồng bộ.",
    keywords: "chuyển máy đổi laptop xuất nhập export import sao lưu lịch sử chat memory resume",
  },
  {
    id: "flows",
    section: "AI",
    title: "Flows",
    body: "Flow là chuỗi các bước anh vẽ trên canvas và chạy khi cần. Flows ở thanh bên liệt kê flow của dự án (lưu trong .aime/flows), Flow của tôi, Mẫu và Kết nối. Tạo flow bằng cách mô tả rồi bấm Vẽ, hoặc thêm bước từ palette (lượt AI, lệnh, điều kiện, HTTP API, git / PR, mail, file và các loại khác). Kéo từ cổng phải của một bước sang cổng trái của bước sau để nối; chuột phải để có thêm thao tác; Ctrl+Z / Ctrl+Y để hoàn tác và làm lại. Dùng {{step.value.field}} để lấy kết quả của bước trước. Thử bước này chạy riêng một bước; Chạy… nhận mọi đầu vào (chữ, file, ticket), Xem trước chạy mà không thay đổi gì. Bước nào lỗi thì Hỏi AI xem hỏng ở đâu để AI đề xuất cách sửa. Lịch sử liệt kê các lần chạy, lần chạy bị ngắt có thể Chạy tiếp. Secret ({{secret.NAME}}) được giữ trong keychain của hệ điều hành.",
    keywords:
      "flows flow workflow pipeline canvas bước dây tự động chạy vẽ mẫu secret kết nối xem trước lịch sử chạy tiếp hoàn tác làm lại phím tắt",
  },
  {
    id: "ai-composer",
    section: "AI",
    title: "Chỉ đúng thứ cần hỏi cho AI",
    body: "Gõ @ trong ô chat để nhắc tới một file. Dán ảnh chụp màn hình bằng Ctrl+V để đính kèm. Khi chat còn trống, các prompt gợi ý hiện phía trên ô nhập.",
    keywords: "@ nhắc file bảng chọn đường dẫn gợi ý mở đầu khung chat",
  },
  {
    id: "inline-ai",
    section: "AI",
    title: "Gợi ý ngay tại con trỏ",
    body: "Ctrl+Alt+Space nhờ AI viết nốt dòng hoặc khối đang đứng; Tab để nhận, Esc để bỏ. Chip trên status bar đổi giữa Khi gọi (mặc định), Tự động và Tắt. Mỗi gợi ý mất vài giây và tốn token; Ctrl+Space là gợi ý tức thì của language server.",
    keywords: "gợi ý mờ ghost text inline completion ctrl+alt+space tự động hoàn thành ai copilot",
  },
  {
    id: "ai-actions",
    section: "AI",
    title: "Hỏi AI ngay trên đoạn code đang xem",
    body: "Bôi đen code, chuột phải, rồi chọn giải thích, viết lại cho gọn, viết test, sửa bug hoặc thêm chú thích. Không chọn gì thì lấy cả file. Hoàn tác lượt này để bỏ mọi thay đổi.",
    keywords: "giải thích refactor test sửa bug chú thích chuột phải bôi đen menu ai",
  },
  {
    id: "palette",
    section: "Giao diện & phím tắt",
    title: "Command palette",
    body: "Ctrl+K (hoặc Ctrl+P) tìm cả lệnh lẫn file; bắt đầu bằng '>' để chỉ tìm lệnh. Enter để chạy hoặc mở, Esc để đóng.",
    keywords: "tìm nhanh mở file lệnh ctrl+k ctrl+p fuzzy",
  },
  {
    id: "panels",
    section: "Giao diện & phím tắt",
    title: "Các panel",
    body: "Kéo vạch chia để đổi kích thước; kéo nhỏ quá mức tối thiểu thì panel thu gọn lại. Ctrl+B cây file, Ctrl+L panel AI, Ctrl+` terminal.",
    keywords: "bố cục sidebar thu gọn",
  },
  {
    id: "theme-lang",
    section: "Giao diện & phím tắt",
    title: "Theme & ngôn ngữ",
    body: "Trên status bar: nút mặt trời/mặt trăng đổi sáng/tối, nút EN/VI đổi ngôn ngữ giao diện.",
    keywords: "dark light tối sáng tiếng việt",
  },
  {
    id: "shortcuts",
    section: "Giao diện & phím tắt",
    title: "Toàn bộ phím tắt",
    body: "Ctrl+K/Ctrl+P command palette · Ctrl+S lưu · Ctrl+W đóng tab · Ctrl+, cài đặt · Ctrl+B cây file · Ctrl+L panel AI · Ctrl+` terminal · Ctrl+Shift+N cửa sổ mới · F5 gỡ lỗi · F12 tới định nghĩa · Ctrl+Alt+Space gợi ý AI · F1 trợ giúp này.",
    keywords: "keyboard phím tắt",
  },
];

export const HELP_TOPICS: Record<Locale, HelpTopic[]> = { en: EN, vi: VI };

/** Case-insensitive filter over title, body, and keywords. */
export function searchHelp(topics: HelpTopic[], query: string): HelpTopic[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return topics;
  return topics.filter((topic) =>
    `${topic.title} ${topic.body} ${topic.keywords ?? ""} ${topic.section}`.toLowerCase().includes(needle),
  );
}
