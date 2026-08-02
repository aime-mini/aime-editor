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
    body: "On the welcome screen: Open Folder picks any folder, Recent reopens the last 8 workspaces, New Project creates a folder and opens it in one step, and Clone Repository takes a git URL, asks where to put it, and opens the clone - no terminal needed. A single quiet line at the bottom reports what Aime found on this machine - it either says everything is ready or names what is missing, and opens the full list (both AI CLIs with their sign-in state, Git, Node, language servers) with the exact command to fix each one.",
    keywords: "workspace recent folder start clone git url github",
  },
  {
    id: "updates",
    section: "Getting started",
    title: "Updates",
    body: "Aime checks once per launch whether a newer version was published. When there is one, a bar appears at the top of the window with the version number - nothing downloads until you press Update now, and dismissing it keeps quiet until the next launch. Updates are signed, so a build that was not produced by the project's own release job is refused.",
    keywords: "update upgrade version release auto-update signed",
  },
  {
    id: "cli",
    section: "Getting started",
    title: "Open from the terminal",
    body: "Type `aime .` in any terminal to open Aime in the current folder, or `aime <path>` for a specific one. A running app is reused.",
    keywords: "command line launcher code",
  },
  {
    id: "multi-window",
    section: "Getting started",
    title: "Multiple projects at once",
    body: "Ctrl+Shift+N, the window button in the status bar, or New Window on the welcome screen opens an independent window - each has its own project, AI chat, and terminals.",
    keywords: "new window parallel",
  },
  {
    id: "switch-close",
    section: "Workspace",
    title: "Switch or close the workspace",
    body: "Hover the project name on top of the file tree: the folder icon opens another workspace, the X closes it and returns to the welcome screen. Right-clicking the name offers the same actions.",
    keywords: "close folder back exit change project",
  },
  {
    id: "file-tree",
    section: "Workspace",
    title: "File tree",
    body: "Click opens a file; right-click offers Open, Reveal in File Explorer, Git Blame (per-line authors - click a commit to see its patch), New File, New Folder, Rename, and Delete. Drag & drop moves items: drop onto a folder to move inside it, onto another file to move next to it, onto the project name to move to the root.",
    keywords: "drag drop move create rename delete context menu reveal explorer blame",
  },
  {
    id: "live-updates",
    section: "Workspace",
    title: "Live updates",
    body: "Changes made outside the editor - including the AI's edits - appear in the tree and the open file automatically, without collapsing expanded folders.",
    keywords: "watcher refresh sync",
  },
  {
    id: "editor",
    section: "Editor",
    title: "Editing & saving",
    body: "Every file you open gets its own tab, and unsaved text stays put when you switch between them - a half-written thought survives going to another file and back. A dot on the tab marks unsaved changes, the x or a middle-click closes it, Ctrl+W closes the current one. Ctrl+S saves; undoing back to the saved state clears the dot.",
    keywords: "save dirty modified undo ctrl+z monaco tab tabs multiple files close switch",
  },
  {
    id: "lsp",
    section: "Editor",
    title: "Code intelligence (completions, types, go to definition)",
    body: "Aime speaks LSP to the same language servers VS Code uses, so typing '.' offers real completions, hovering shows types and docs, F12 jumps to a definition, Shift+F12 lists every reference, F2 renames a symbol across the whole project - files that are not open are rewritten on disk, open ones get normal undoable edits - signature help appears inside call parentheses, and errors underline themselves as you type. Aime highlights ~80 languages out of the box - that part is bundled - and ships full IntelliSense for TypeScript, JavaScript, HTML, CSS and JSON. The rest needs a language server, 20-200 MB each, so none are bundled. Instead the first launch quietly installs the small user-scoped ones for you (Python, PHP, SQL, shell, YAML, Dockerfile) without asking, since that is the deal with using Aime; and opening a file whose language has no server offers that one server right there. It runs the real installer and shows every line. Without any of it you still get syntax highlighting everywhere, and full IntelliSense for TypeScript, JavaScript, HTML, CSS and JSON, which Monaco ships built in. The language chip in the status bar tells you the state: green means a server is running, amber means it is missing and its tooltip carries the exact install command. TypeScript and JavaScript still get Monaco's built-in IntelliSense even with no server installed.",
    keywords:
      "lsp intellisense completion autocomplete hover definition f12 diagnostics errors gopls pyright rust-analyzer",
  },
  {
    id: "ai-requirements",
    section: "AI",
    title: "What the AI needs (and what works without it)",
    body: "The AI runs through an AI CLI installed on your machine: npm install -g @anthropic-ai/claude-code for Claude Code, npm install -g @openai/codex for Codex. Aime probes the selected CLI on start: if it is missing it shows the install command, if it is not signed in it offers a one-click sign-in. Without AI the editor, file tree, terminal and Git keep working normally.",
    keywords: "install login sign in requirements offline manual no ai codex claude",
  },
  {
    id: "ai-provider",
    section: "AI",
    title: "Choose the AI CLI & sign in",
    body: "The first chip in the AI panel header switches between Claude Code and Codex. Switching starts a new session, because a resume id belongs to one CLI - previous sessions keep the CLI they were created with. The key button next to it signs you in: it opens a terminal tab running that CLI's own login command (claude auth login / codex login), so your credentials stay with the CLI and never pass through Aime. It turns green once you are signed in, and clicking it then just confirms that; after signing in, Aime detects it by itself.",
    keywords: "provider switch codex claude login sign in key account",
  },
  {
    id: "ai-add-provider",
    section: "AI",
    title: "Use another AI CLI",
    body: "Claude Code and Codex are built in, but any command-line AI can be added without waiting for a new Aime release: 'Add an AI CLI' in the command palette creates providers.json with a working example and opens it. Describe the command, where the prompt goes ({prompt}), how to resume a conversation ({sessionId}), and whether it prints plain text or JSON per line. The new CLI then appears in the provider picker like the built-in ones. Aime cannot know its models or its permission flags, so it sends what every CLI understands: the instruction in the prompt itself - including your AGENTS.md when the CLI has no memory file of its own.",
    keywords: "providers.json generic adapter gemini custom cli add provider",
  },
  {
    id: "ai-chat",
    section: "AI",
    title: "Chat with the AI",
    body: "With a folder open, type a prompt and press Enter. The AI reads and edits your project and runs commands; tool calls appear as chips, cost and duration after each turn. Stop cancels a running turn.",
    keywords: "prompt send claude agent tool",
  },
  {
    id: "ai-model",
    section: "AI",
    title: "Model & effort",
    body: "The chips above the chat choose the model and the reasoning effort of the selected CLI. For Claude, aliases like Opus (latest) track the newest release while pinned versions (e.g. Opus 4.8) stay fixed; for Codex the list is its model catalog (GPT-5.6 Sol, Terra, Luna…). The effort list follows the chosen model - only levels that model accepts are offered. Auto leaves the decision to the CLI's own settings.",
    keywords: "opus sonnet haiku fable gpt codex version xhigh ultra effort picker",
  },
  {
    id: "ai-approve",
    section: "AI",
    title: "How much the AI may do (permissions)",
    body: "The shield chip cycles three levels: FULL - every tool runs unprompted; EDITS - files are edited freely while commands stay sandboxed to this project; READ-ONLY - the AI reads and explains but changes nothing, which is the safe way to explore an unfamiliar codebase. The choice is remembered and applies to both CLIs, mapped onto each one's own flags. Aime deliberately has no per-command Allow/Deny popup: that needs a bundled Node sidecar only one CLI supports, and it would cost the app its size and speed.",
    keywords: "permission bypass sandbox read-only plan command safety shield",
  },
  {
    id: "ai-usage",
    section: "AI",
    title: "Usage & cost",
    body: "The activity button above the chat shows this session's totals: input/output tokens and cache reads/writes, plus cost for CLIs that report one. Claude Code reports a price per turn; Codex bills through your subscription and reports none, so Aime shows tokens only instead of inventing a number.",
    keywords: "tokens cost money spend activity subscription",
  },
  {
    id: "ai-sessions",
    section: "AI",
    title: "Sessions & memory",
    body: "Chats are saved per project and restored when you reopen it - the AI resumes with its full context, even after a restart. The history button switches between the project's last 20 sessions; + starts a fresh one. The AI also maintains .aime/PROGRESS.md as a progress journal, so long tasks survive any interruption.",
    keywords: "resume history restore context progress journal remember",
  },
  {
    id: "ai-memory-editor",
    section: "AI",
    title: "Edit the AI's memory",
    body: "The brain button above the chat (or 'Edit AI memory' in the command palette) opens the memory editor. The Project tab edits one canonical AGENTS.md in your repo (conventions, architecture - shared via git): Codex reads it natively and Aime keeps an @AGENTS.md import in CLAUDE.md so Claude reads the very same file - no copies to drift apart. The Global tab edits the selected CLI's own user-level file (~/.claude/CLAUDE.md or ~/.codex/AGENTS.md). The AI re-reads them every turn, so saves take effect immediately.",
    keywords: "memory agents.md claude.md global project knowledge notes brain",
  },
  {
    id: "mcp",
    section: "AI",
    title: "MCP servers (the AI's plugins)",
    body: "The plug button in the AI panel header (or 'MCP servers' in the command palette) manages the Model Context Protocol servers of the selected CLI - issue trackers, docs, databases the AI can then use as tools. Browse & search opens a curated list grouped by what they do - issue boards, design tools, docs, cloud platforms, local tools - and a search box over the official MCP registry, so anything published there is one click away. Picking an entry fills the form (including the environment variables it requires) instead of adding it behind your back; you can also paste a URL or a command such as npx -y server-github yourself. Aime drives the CLI's own mcp commands, so servers stay where the CLI expects them and its health checks and OAuth keep working - note that Claude Code stores them per project while Codex stores them globally; the key button on a row signs in to that server in a terminal.",
    keywords: "mcp plugin tools server add remove connector github notion",
  },
  {
    id: "git",
    section: "Git",
    title: "Git panel",
    body: "The Git tab in the sidebar (or the branch name in the status bar) shows your changes: stage/unstage per file or all at once, discard changes, commit (Ctrl+Enter in the message box), push and pull. Click a file to see its diff against HEAD; the History section (collapsible, own scroll, Load more) lists commits - click one to view its full patch. Changed files get letters in the file tree and changed lines get colored marks in the editor gutter. Smart by default: committing with nothing staged stages everything first, and the first push of a new branch sets its upstream automatically. Works entirely without AI; with AI, the sparkle button writes the commit message from the staged (or unstaged) diff.",
    keywords: "commit stage diff push pull branch source control version init",
  },
  {
    id: "git-branches",
    section: "Git",
    title: "Branches, remotes and tags",
    body: "Click the branch name to switch branches, create one, rename the current one, merge another into it, or delete one - deleting a branch that still holds unmerged commits asks a second time before losing that work. The ... button next to Refresh manages remotes (add one, or repoint an existing one at a new URL) and tags (create lightweight or annotated, delete, push them all). The download arrow fetches remote branches without touching your files.",
    keywords: "branch rename delete merge remote origin url tag fetch prune",
  },
  {
    id: "git-history-ops",
    section: "Git",
    title: "Undoing and moving commits",
    body: "Right-click a commit in History: copy its id, revert it (a new commit undoes it - the safe choice for work already pushed), cherry-pick it onto the current branch, or move the branch back to it. Reset comes in three flavours the dialog spells out: keep the changes staged, keep them in your files unstaged, or discard them entirely - the last one says plainly that it cannot be undone.",
    keywords: "revert undo cherry-pick reset soft mixed hard rollback commit id sha",
  },
  {
    id: "git-conflicts",
    section: "Git",
    title: "Resolve merge conflicts",
    body: "Conflicted files appear in a red Merge conflicts section - click Resolve to open the conflict view. Each conflict shows Ours and Theirs side by side (plus the common ancestor when available): keep either side, keep both, edit the result by hand, or let AI merge one block - or every block - for you. Save & mark resolved rewrites the file and stages it. Unfinished blocks are never lost: the save button stays locked until every conflict has a decision.",
    keywords: "merge conflict resolve ours theirs ai rebase pull markers",
  },
  {
    id: "git-blame-branch",
    section: "Git",
    title: "Blame & branches",
    body: "The line under your cursor shows who last changed it and when (inline, dimmed, GitLens style). Click the branch name in the Git panel to switch branches or create a new one.",
    keywords: "blame author annotate branch checkout switch create",
  },
  {
    id: "git-stash-amend",
    section: "Git",
    title: "Stash & amend",
    body: "The archive button in the Changes header stashes everything (untracked included, optional message). Stashes list below with Pop (apply & remove), Apply (keep), and Delete. The Amend checkbox next to Commit rewrites the last commit - leave the message empty to keep the old one. A conflicted file open in the editor shows a red banner that jumps straight to the resolver.",
    keywords: "stash save shelve amend rewrite last commit wip",
  },
  {
    id: "git-multiselect",
    section: "Git",
    title: "Select multiple changes",
    body: "In the Staged/Changes lists: click selects a file (and opens its diff), Ctrl+click adds or removes files from the selection, Shift+click selects a range. Right-click for a menu that stages, unstages, or discards everything selected at once.",
    keywords: "multi select ctrl shift right click context menu bulk",
  },
  {
    id: "terminal",
    section: "Terminal",
    title: "Integrated terminal",
    body: "Ctrl+` (or the status bar button) toggles a PowerShell terminal in the project root. + opens more tabs; every tab is its own shell and hiding the panel never kills it.",
    keywords: "shell powershell tabs console",
  },
  {
    id: "tasks",
    section: "Tasks",
    title: "Run, build and test",
    body: "The play button in the status bar (or 'Run task' in the command palette) lists what Aime detected for this project: npm scripts, cargo, go, dotnet, pytest, docker. A task runs in its own terminal tab named after it, so you see the real output and can interact with it. Add or override tasks in .aime/tasks.json (id, label, kind, command) - an entry reusing a detected id replaces it.",
    keywords: "task run build test publish npm cargo dotnet go pytest docker tasks.json",
  },
  {
    id: "tasks-fix",
    section: "Tasks",
    title: "Fix a failure with AI",
    body: "When a task exits with a non-zero code, a red bar appears above the terminal. Fix with AI sends the command, the exit code and the captured output to the AI panel and asks it to find the cause, fix it, and run the task again. Without AI the bar is simply a failure notice you can dismiss.",
    keywords: "fix error failure build failed exit code ai repair",
  },
  {
    id: "palette",
    section: "UI & shortcuts",
    title: "Command palette",
    body: "Ctrl+K (or Ctrl+P) opens one box for everything: type to fuzzy-search commands and workspace files together; start with '>' to see commands only. Arrows navigate, Enter runs a command or opens a file, Esc closes.",
    keywords: "quick open search jump command ctrl+k ctrl+p fuzzy",
  },
  {
    id: "panels",
    section: "UI & shortcuts",
    title: "Panels",
    body: "Drag the dividers to resize. Dragging below the minimum collapses a panel into a thin rail with an expand button. Ctrl+B (file tree), Ctrl+L (AI panel), Ctrl+` (terminal) or the status bar buttons toggle them.",
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
    body: "Ctrl+K/Ctrl+P command palette · Ctrl+S save · Ctrl+B file tree · Ctrl+L AI panel · Ctrl+` terminal · Ctrl+Shift+N new window · F1 this help.",
    keywords: "keyboard hotkeys keys",
  },
];

const VI: HelpTopic[] = [
  {
    id: "open-project",
    section: "Bắt đầu",
    title: "Mở dự án",
    body: "Ở màn hình chào: Open Folder chọn thư mục bất kỳ, Recent mở lại 8 workspace gần nhất, New Project tạo thư mục mới và mở luôn.",
    keywords: "workspace recent folder mở thư mục",
  },
  {
    id: "updates",
    section: "Bắt đầu",
    title: "Cập nhật",
    body: "Mỗi lần mở app Aime kiểm tra một lần xem có bản mới chưa. Có thì hiện một thanh trên cùng cửa sổ kèm số phiên bản - không tải gì cho tới khi anh bấm Cập nhật ngay, bấm X thì im tới lần mở sau. Bản cập nhật có ký số, nên bản dựng không phải do quy trình phát hành của dự án tạo ra sẽ bị từ chối.",
    keywords: "cập nhật update phiên bản release ký số",
  },
  {
    id: "cli",
    section: "Bắt đầu",
    title: "Mở từ terminal",
    body: "Gõ `aime .` trong terminal bất kỳ để mở Aime tại thư mục hiện hành, hoặc `aime <đường dẫn>`. App đang chạy sẽ được dùng lại.",
    keywords: "command line launcher dòng lệnh",
  },
  {
    id: "multi-window",
    section: "Bắt đầu",
    title: "Nhiều dự án song song",
    body: "Ctrl+Shift+N, nút cửa sổ trên status bar, hoặc New Window ở màn hình chào - mỗi cửa sổ là một workspace độc lập với AI chat và terminal riêng.",
    keywords: "cửa sổ mới new window",
  },
  {
    id: "switch-close",
    section: "Workspace",
    title: "Đổi hoặc đóng workspace",
    body: "Rê chuột vào tên dự án trên đầu cây file: icon thư mục để mở workspace khác, dấu X để đóng và quay về màn hình chào. Chuột phải vào tên cũng có các lệnh này.",
    keywords: "đóng thư mục quay lại close folder",
  },
  {
    id: "file-tree",
    section: "Workspace",
    title: "Cây file",
    body: "Click mở file; chuột phải có Mở, Mở trong File Explorer, Git Blame (tác giả từng dòng - bấm commit để xem patch), Tạo file, Tạo thư mục, Đổi tên, Xóa. Kéo-thả để di chuyển: thả vào thư mục để đưa vào trong, thả vào file khác để nằm cạnh nó, thả vào tên dự án để đưa ra gốc.",
    keywords: "kéo thả di chuyển tạo xóa đổi tên drag drop reveal explorer blame",
  },
  {
    id: "live-updates",
    section: "Workspace",
    title: "Cập nhật trực tiếp",
    body: "Thay đổi từ bên ngoài editor - kể cả do AI sửa - tự hiện trong cây file và file đang mở, không làm sập trạng thái mở rộng của cây.",
    keywords: "watcher tự động refresh",
  },
  {
    id: "editor",
    section: "Editor",
    title: "Soạn thảo & lưu",
    body: "Ctrl+S để lưu. Chấm tròn cạnh đường dẫn file báo thay đổi chưa lưu; Ctrl+Z về đúng bản đã lưu thì chấm tự tắt.",
    keywords: "lưu save dirty undo",
  },
  {
    id: "lsp",
    section: "Editor",
    title: "Code intelligence (gợi ý, kiểu, nhảy tới định nghĩa)",
    body: "Aime nói chuyện LSP với đúng những language server mà VS Code dùng: gõ '.' ra gợi ý thật, rê chuột thấy kiểu và tài liệu, F12 nhảy tới định nghĩa, Shift+F12 liệt kê mọi chỗ dùng, F2 đổi tên biến/hàm trên toàn dự án - file chưa mở được ghi thẳng xuống đĩa, file đang mở nhận sửa đổi bình thường và undo được - gợi ý tham số hiện trong ngoặc hàm, lỗi gạch chân ngay khi gõ. Aime tô màu sẵn ~80 ngôn ngữ - phần đó đóng gói kèm - và có IntelliSense đầy đủ cho TypeScript, JavaScript, HTML, CSS, JSON. Còn lại cần language server, mỗi cái 20-200 MB nên không gói kèm. Thay vào đó lần mở đầu tiên Aime tự lặng lẽ cài nhóm nhỏ chạy trong thư mục người dùng (Python, PHP, SQL, shell, YAML, Dockerfile) mà không hỏi, vì đó là thoả thuận khi dùng Aime; và khi mở file thuộc ngôn ngữ chưa có server thì đề nghị ngay tại chỗ. Nó chạy trình cài thật và hiện từng dòng. Không cài gì thì vẫn có tô màu cú pháp cho mọi ngôn ngữ, và IntelliSense đầy đủ cho TypeScript, JavaScript, HTML, CSS, JSON vì Monaco có sẵn. Chip ngôn ngữ trên status bar cho biết trạng thái: xanh là server đang chạy, vàng là chưa cài và tooltip ghi sẵn lệnh cài. Riêng TypeScript/JavaScript vẫn có IntelliSense sẵn của Monaco kể cả khi chưa cài server.",
    keywords:
      "lsp intellisense gợi ý autocomplete hover định nghĩa f12 lỗi chẩn đoán gopls pyright rust-analyzer",
  },
  {
    id: "ai-requirements",
    section: "AI",
    title: "AI cần gì (và không có AI vẫn dùng được gì)",
    body: "AI chạy qua một AI CLI cài trên máy bạn: npm install -g @anthropic-ai/claude-code cho Claude Code, npm install -g @openai/codex cho Codex. Aime tự dò CLI đang chọn: chưa cài thì hiện lệnh cài, chưa đăng nhập thì hiện nút đăng nhập một chạm. Không có AI thì editor, cây file, terminal và Git vẫn chạy bình thường.",
    keywords: "cài đặt đăng nhập login yêu cầu offline thủ công không có ai codex claude",
  },
  {
    id: "ai-provider",
    section: "AI",
    title: "Chọn AI CLI & đăng nhập",
    body: "Chip đầu tiên trên header panel AI chuyển giữa Claude Code và Codex. Đổi provider sẽ mở phiên mới vì id resume thuộc về đúng một CLI - các phiên cũ vẫn giữ CLI đã tạo ra chúng. Nút chìa khóa bên cạnh dùng để đăng nhập: nó mở một tab terminal chạy đúng lệnh login của CLI đó (claude auth login / codex login), nên thông tin đăng nhập nằm ở CLI, không đi qua Aime. Đăng nhập rồi thì nút chuyển màu xanh, bấm vào chỉ báo là đã đăng nhập; sau khi login xong Aime tự nhận, không cần bấm gì thêm.",
    keywords: "provider đổi codex claude đăng nhập login chìa khóa tài khoản",
  },
  {
    id: "ai-add-provider",
    section: "AI",
    title: "Dùng AI CLI khác",
    body: "Claude Code và Codex có sẵn, nhưng anh thêm được bất kỳ AI chạy dòng lệnh nào mà không cần chờ bản Aime mới: lệnh 'Thêm AI CLI' trong command palette tạo sẵn providers.json có mẫu chạy được và mở lên. Anh khai lệnh chạy, chỗ đặt prompt ({prompt}), cách nối lại hội thoại ({sessionId}), và nó in text thường hay JSON mỗi dòng. Xong là CLI đó hiện trong picker như hai cái có sẵn. Aime không thể biết model hay cờ phân quyền của nó, nên gửi thứ mọi CLI đều hiểu: chỉ dẫn nằm ngay trong prompt - kèm cả AGENTS.md của anh nếu CLI đó không có file memory riêng.",
    keywords: "providers.json generic adapter gemini cli tùy chỉnh thêm provider",
  },
  {
    id: "ai-chat",
    section: "AI",
    title: "Chat với AI",
    body: "Mở thư mục xong, gõ yêu cầu và Enter. AI đọc/sửa dự án và chạy lệnh; tool hiện thành chip, chi phí và thời gian hiện sau mỗi lượt. Nút Stop hủy lượt đang chạy.",
    keywords: "prompt gửi claude agent",
  },
  {
    id: "ai-model",
    section: "AI",
    title: "Model & effort",
    body: "Hai chip trên khung chat chọn model và mức suy luận của CLI đang dùng. Với Claude, alias như Opus (latest) luôn theo bản mới nhất, bản pin (vd Opus 4.8) đứng yên; với Codex là danh mục model của nó (GPT-5.6 Sol, Terra, Luna…). Danh sách effort bám theo model đã chọn - chỉ hiện mức model đó chấp nhận. Auto = để cấu hình của chính CLI quyết định.",
    keywords: "opus sonnet haiku fable gpt codex phiên bản effort ultra",
  },
  {
    id: "ai-approve",
    section: "AI",
    title: "AI được làm tới đâu (quyền)",
    body: "Chip khiên xoay vòng 3 mức: TOÀN QUYỀN - mọi tool chạy không hỏi; SỬA FILE - sửa file thoải mái còn lệnh chạy trong sandbox giới hạn ở dự án này; CHỈ ĐỌC - AI đọc và giải thích nhưng không thay đổi gì, hợp khi mới vào một codebase lạ. Lựa chọn được ghi nhớ và áp dụng cho cả hai CLI, ánh xạ sang đúng cờ của từng CLI. Aime cố ý không có popup Allow/Deny từng lệnh: nó cần đóng gói thêm một sidecar Node mà chỉ một CLI hỗ trợ, đánh đổi bằng dung lượng và tốc độ của app.",
    keywords: "permission quyền sandbox chỉ đọc an toàn khiên",
  },
  {
    id: "ai-usage",
    section: "AI",
    title: "Mức dùng & chi phí",
    body: "Nút activity trên khung chat hiển thị tổng của phiên: token vào/ra, cache đọc/ghi, kèm chi phí với CLI nào có báo giá. Claude Code báo chi phí từng lượt; Codex tính theo gói thuê bao và không báo giá, nên Aime chỉ hiện token thay vì bịa ra con số.",
    keywords: "token chi phí tiền usage thuê bao",
  },
  {
    id: "ai-sessions",
    section: "AI",
    title: "Phiên & bộ nhớ",
    body: "Hội thoại được lưu theo từng dự án và khôi phục khi mở lại - AI tiếp tục với đầy đủ ngữ cảnh, kể cả sau khi tắt app. Nút lịch sử chuyển giữa 20 phiên gần nhất; dấu + tạo phiên mới. AI còn tự ghi nhật ký tiến độ .aime/PROGRESS.md nên task dài không bao giờ mất dấu.",
    keywords: "resume lịch sử khôi phục ngữ cảnh nhớ tiến độ",
  },
  {
    id: "ai-memory-editor",
    section: "AI",
    title: "Sửa bộ nhớ của AI",
    body: "Nút hình não trên khung chat (hoặc 'Sửa bộ nhớ AI' trong command palette) mở trình sửa memory. Tab Dự án sửa một file AGENTS.md duy nhất trong repo (quy ước, kiến trúc - chia sẻ qua git): Codex đọc thẳng, còn Aime giữ dòng import @AGENTS.md trong CLAUDE.md để Claude đọc đúng file đó - không nhân bản nên không bao giờ lệch nhau. Tab Toàn cục sửa file người dùng của chính CLI đang chọn (~/.claude/CLAUDE.md hoặc ~/.codex/AGENTS.md). AI đọc lại mỗi lượt nên lưu xong là có hiệu lực ngay.",
    keywords: "memory agents.md claude.md toàn cục dự án kiến thức ghi chú não",
  },
  {
    id: "mcp",
    section: "AI",
    title: "MCP server (plugin cho AI)",
    body: "Nút phích cắm trên header panel AI (hoặc 'MCP server' trong command palette) quản lý các MCP server của CLI đang chọn - issue tracker, tài liệu, database… để AI dùng như tool. Nút 'Duyệt & tìm server' mở danh mục có sẵn chia theo nhóm - issue board, thiết kế, tài liệu, cloud, tool chạy máy - kèm ô tìm kiếm trên registry MCP chính thức, nên server nào đã publish ở đó đều thêm được bằng một cú bấm. Chọn một mục sẽ điền sẵn vào form (kể cả biến môi trường nó cần) chứ không tự thêm sau lưng bạn; anh vẫn có thể tự dán URL hoặc gõ lệnh kiểu npx -y server-github. Aime gọi đúng lệnh mcp của CLI nên server nằm đúng chỗ CLI mong đợi, health check và OAuth của nó vẫn chạy - lưu ý Claude Code lưu theo dự án còn Codex lưu global; nút chìa khóa trên mỗi dòng mở terminal để đăng nhập server đó.",
    keywords: "mcp plugin tool server thêm xoá connector github notion",
  },
  {
    id: "git",
    section: "Git",
    title: "Panel Git",
    body: "Tab Git ở sidebar (hoặc bấm tên branch trên status bar) hiển thị thay đổi: stage/bỏ stage từng file hoặc tất cả, hủy thay đổi, commit (Ctrl+Enter trong ô nội dung), push và pull. Bấm vào file để xem diff so với HEAD; khu Lịch sử (gập/mở, cuộn riêng, nút Tải thêm) liệt kê commit - bấm vào để xem trọn patch. File thay đổi có chữ trạng thái trong cây file, dòng thay đổi có vạch màu ở lề editor. Thông minh mặc định: commit khi chưa stage gì sẽ tự stage toàn bộ, push lần đầu của nhánh mới tự thiết lập upstream. Hoạt động hoàn toàn không cần AI; có AI thì nút lấp lánh tự viết nội dung commit từ diff (đã stage hoặc chưa).",
    keywords: "commit stage diff push pull nhánh branch quản lý phiên bản init",
  },
  {
    id: "git-branches",
    section: "Git",
    title: "Nhánh, remote và tag",
    body: "Bấm tên nhánh để chuyển nhánh, tạo nhánh, đổi tên nhánh hiện tại, merge nhánh khác vào, hoặc xoá nhánh - xoá nhánh còn commit chưa merge thì hỏi lại lần nữa trước khi mất phần việc đó. Nút ... cạnh Refresh quản lý remote (thêm mới, hoặc trỏ remote cũ sang URL khác) và tag (tạo tag thường hoặc annotated, xoá, push toàn bộ). Mũi tên tải xuống là fetch - cập nhật nhánh từ remote mà không đụng file của bạn.",
    keywords: "nhánh đổi tên xoá merge remote origin url tag fetch",
  },
  {
    id: "git-history-ops",
    section: "Git",
    title: "Hoàn tác và di chuyển commit",
    body: "Chuột phải vào một commit trong Lịch sử: chép mã commit, revert nó (tạo commit mới đảo ngược - cách an toàn cho việc đã push), cherry-pick sang nhánh hiện tại, hoặc chuyển nhánh về đúng commit đó. Reset có 3 kiểu và hộp thoại nói rõ từng kiểu: giữ thay đổi ở vùng stage, giữ trong file nhưng chưa stage, hoặc bỏ sạch - kiểu cuối ghi thẳng là không hoàn tác được.",
    keywords: "revert hoàn tác cherry-pick reset soft mixed hard commit sha",
  },
  {
    id: "git-conflicts",
    section: "Git",
    title: "Giải quyết xung đột merge",
    body: "File bị xung đột hiện trong khu Xung đột merge màu đỏ - bấm Giải quyết để mở trình xử lý. Mỗi xung đột hiển thị Bên mình và Bên kia cạnh nhau (kèm gốc chung nếu có): giữ một bên, giữ cả hai, tự sửa kết quả, hoặc để AI hòa giải từng khối - hay toàn bộ. Lưu & đánh dấu đã giải sẽ ghi file và stage luôn. Không bao giờ mất nội dung: nút lưu bị khóa cho tới khi mọi xung đột đều có quyết định.",
    keywords: "merge conflict xung đột giải quyết ours theirs ai rebase pull",
  },
  {
    id: "git-blame-branch",
    section: "Git",
    title: "Blame & nhánh",
    body: "Dòng đang đặt con trỏ hiển thị ai sửa lần cuối và khi nào (chữ mờ cuối dòng, kiểu GitLens). Bấm tên nhánh trong panel Git để chuyển nhánh hoặc tạo nhánh mới.",
    keywords: "blame tác giả nhánh branch checkout chuyển tạo",
  },
  {
    id: "git-stash-amend",
    section: "Git",
    title: "Stash & amend",
    body: "Nút lưu trữ trên header Thay đổi sẽ stash toàn bộ (kể cả file chưa track, message tùy chọn). Danh sách stash bên dưới với Pop (áp dụng & xóa), Áp dụng (giữ lại), Xóa. Ô Amend cạnh nút Commit ghi đè commit cuối - để trống nội dung thì giữ message cũ. Mở file đang xung đột trong editor sẽ thấy banner đỏ nhảy thẳng tới trình giải conflict.",
    keywords: "stash cất tạm amend sửa commit cuối wip",
  },
  {
    id: "git-multiselect",
    section: "Git",
    title: "Chọn nhiều thay đổi",
    body: "Trong danh sách Đã stage/Thay đổi: click chọn một file (và mở diff), Ctrl+click thêm/bớt file vào vùng chọn, Shift+click chọn cả dải. Chuột phải mở menu để stage, bỏ stage hoặc hủy thay đổi tất cả file đang chọn cùng lúc.",
    keywords: "chọn nhiều ctrl shift chuột phải menu hàng loạt",
  },
  {
    id: "terminal",
    section: "Terminal",
    title: "Terminal tích hợp",
    body: "Ctrl+` (hoặc nút trên status bar) bật terminal PowerShell tại gốc dự án. Dấu + mở thêm tab; mỗi tab là một shell riêng, ẩn panel không làm mất phiên.",
    keywords: "shell powershell tab console",
  },
  {
    id: "tasks",
    section: "Task",
    title: "Chạy, build và test",
    body: "Nút play trên status bar (hoặc 'Chạy task' trong command palette) liệt kê những gì Aime phát hiện cho dự án: script npm, cargo, go, dotnet, pytest, docker. Task chạy trong tab terminal riêng mang tên nó, nên bạn thấy output thật và vẫn tương tác được. Thêm hoặc ghi đè task bằng .aime/tasks.json (id, label, kind, command) - mục nào trùng id với task tự phát hiện sẽ thay thế task đó.",
    keywords: "task chạy build test publish npm cargo dotnet go pytest docker tasks.json",
  },
  {
    id: "tasks-fix",
    section: "Task",
    title: "Nhờ AI sửa khi task lỗi",
    body: "Khi task kết thúc với mã lỗi khác 0, một thanh đỏ hiện phía trên terminal. Nút 'Nhờ AI sửa' gửi lệnh, mã lỗi và output đã bắt được sang panel AI, yêu cầu AI tìm nguyên nhân, sửa rồi chạy lại task để xác nhận. Không dùng AI thì thanh đó chỉ là thông báo lỗi, bấm X để bỏ qua.",
    keywords: "sửa lỗi build fail exit code ai khắc phục",
  },
  {
    id: "palette",
    section: "Giao diện & phím tắt",
    title: "Command palette",
    body: "Ctrl+K (hoặc Ctrl+P) mở một ô cho tất cả: gõ để tìm mờ cả lệnh lẫn file trong dự án; bắt đầu bằng '>' để chỉ hiện lệnh. Mũi tên di chuyển, Enter chạy lệnh hoặc mở file, Esc đóng.",
    keywords: "tìm nhanh mở file lệnh ctrl+k ctrl+p fuzzy",
  },
  {
    id: "panels",
    section: "Giao diện & phím tắt",
    title: "Các panel",
    body: "Kéo vạch chia để đổi kích thước. Kéo nhỏ quá mức tối thiểu thì panel thu thành thanh mỏng kèm nút mở lại. Ctrl+B (cây file), Ctrl+L (AI), Ctrl+` (terminal) hoặc nút trên status bar để bật/tắt.",
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
    body: "Ctrl+K/Ctrl+P command palette · Ctrl+S lưu · Ctrl+B cây file · Ctrl+L panel AI · Ctrl+` terminal · Ctrl+Shift+N cửa sổ mới · F1 trợ giúp này.",
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
