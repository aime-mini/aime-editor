<p align="center">
  <img src="src-tauri/icons/logo.svg" width="96" alt="Aime logo" />
</p>

<h1 align="center">Aime - AI Mini Editor</h1>

<p align="center">
  A lightweight desktop code editor with AI agents at its core.<br/>
  Powered by headless AI CLIs - Claude Code today, Codex and any CLI you configure next.
</p>

---

## Why Aime?

AI CLIs (Claude Code, Codex CLI, …) are already complete coding agents: they read and edit files,
run commands, and manage sessions. Aime doesn't rebuild the agent - it is a **thin, fast, beautiful
editor layer** on top of them:

- ⚡ **Genuinely light** - Tauri 2, ~10 MB installer, sub-second startup
- 🤖 **AI panel as the main character** - character-level streaming, tool calls as chips, transparent token costs
- 🧠 **Never loses track** - sessions persist per project and resume with full context after a restart; the agent keeps a `.aime/PROGRESS.md` journal so long tasks survive anything
- 🎛️ **Full control** - model picker (latest aliases + pinned versions), reasoning effort, auto-approve toggle, per-session usage breakdown
- 🖥️ **Integrated terminal** - PowerShell tabs on ConPTY, theme-aware (Ctrl+`)
- 🗂️ **Real workspace** - live file watcher, drag & drop moves, recent folders, `aime .` launcher
- 🪟 **Multi-window** - one window per project, work on 2-3 projects side by side (Ctrl+Shift+N)
- 🌍 **Multilingual UI** - English by default, Vietnamese included; searchable in-app help (F1)
- 🔌 **Open adapters** - every CLI goes through a thin adapter that normalizes its events; the UI never knows which vendor is behind it
- ✍️ **Still a real editor without AI** - the file tree, Monaco editor, and terminal work standalone

## Tech stack

| Layer  | Technology                              |
| ------ | --------------------------------------- |
| Shell  | Tauri 2 (Rust)                          |
| UI     | React 19 + TypeScript + Tailwind CSS 4  |
| Editor | Monaco (bundled locally, fully offline) |
| State  | zustand                                 |

Every AI CLI is reached through an adapter that normalizes its output into one event set, so the UI
never knows which CLI answers: `src-tauri/src/providers/adapter.rs` is the whole contract.

## Running from source

Requirements: Node ≥ 20, Rust (stable; MSVC on Windows). For the AI features, install one of the
supported CLIs - [Claude Code](https://code.claude.com) (`npm install -g @anthropic-ai/claude-code`)
or [Codex](https://github.com/openai/codex) (`npm install -g @openai/codex`) - and sign in from
inside Aime with the key button in the AI panel. Without either, Aime still works as a plain editor
with Git, terminal and tasks.

```bash
npm install
npm run tauri dev      # run the app (the first Rust build takes a while)
npm run tauri build    # package installers
```
