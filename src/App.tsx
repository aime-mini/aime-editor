import { lazy, Suspense, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { AppWindow, FolderOpen, FolderPlus, GitBranch, Loader2 } from "lucide-react";
import logo from "./assets/logo.svg";

/**
 * The whole editor, loaded the moment a project is - and not before.
 *
 * Monaco alone is 4.4 MB of JavaScript. The welcome screen has no editor on
 * it, so waiting for that parse before showing anything is time the user
 * pays for nothing.
 */
const Workbench = lazy(() => import("./components/Workbench"));
import { useT } from "./i18n";
import { EnvironmentCheck } from "./components/EnvironmentCheck";
import { CommandPalette } from "./components/CommandPalette";
import { HelpModal } from "./components/HelpModal";
import { InstallerModal } from "./components/InstallerModal";
import { McpModal } from "./components/McpModal";
import { MemoryModal } from "./components/MemoryModal";
import { PromptModal } from "./components/PromptModal";
import { SettingsModal } from "./components/SettingsModal";
import { StatusBar } from "./components/StatusBar";
import { UpdateNotice } from "./components/UpdateNotice";
import { useAi } from "./stores/ai";
import { useDebug } from "./stores/debug";
import { useLayout } from "./stores/layout";
import { useRecent } from "./stores/recent";
import { useWorkspace } from "./stores/workspace";

const openNewWindow = () => invoke("open_new_window");

function folderNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function WelcomeScreen() {
  const { openFolder, adoptFolder } = useWorkspace();
  const { folders, forget } = useRecent();
  const [newProjectParent, setNewProjectParent] = useState<string | null>(null);
  const [cloneUrl, setCloneUrl] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);
  const t = useT();

  const pickNewProjectLocation = async () => {
    const parent = await open({
      directory: true,
      multiple: false,
      title: t("dialog.pickParentTitle"),
    });
    if (typeof parent === "string") setNewProjectParent(parent);
  };

  const createProject = async (name: string) => {
    if (!newProjectParent) return;
    const path = `${newProjectParent}/${name}`;
    try {
      await invoke("create_dir", { path });
      await adoptFolder(path);
    } catch (err: unknown) {
      console.error("failed to create project folder:", err);
    } finally {
      setNewProjectParent(null);
    }
  };

  /** The folder git itself would create: the repository name without `.git`. */
  const repositoryNameOf = (url: string) =>
    url
      .replace(/\.git$/, "")
      .split(/[\\/:]/)
      .filter(Boolean)
      .pop() ?? "repository";

  const cloneInto = async (url: string) => {
    const parent = await open({ directory: true, multiple: false, title: t("dialog.pickParentTitle") });
    if (typeof parent !== "string") return;
    setCloning(true);
    try {
      const path = await invoke<string>("git_clone", { url, parent, folder: repositoryNameOf(url) });
      await adoptFolder(path);
    } catch (err: unknown) {
      console.error("clone failed:", err);
    } finally {
      setCloning(false);
    }
  };

  const openRecent = async (path: string) => {
    try {
      await invoke("list_dir", { path }); // probe — the folder may have been moved or deleted
      await adoptFolder(path);
    } catch {
      forget(path);
    }
  };

  const actionButton =
    "flex w-full items-center gap-2 rounded-lg border border-line px-4 py-2 font-medium text-muted hover:border-accent hover:text-fg";

  return (
    // Centred while it fits, scrollable the moment it does not - otherwise a
    // long environment report pushes the logo off the top of the window.
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-2xl items-center px-8 py-10">
        <div className="w-full">
          <div className="flex flex-col items-center gap-3">
            <img src={logo} alt="Aime" className="size-20 drop-shadow-lg" />
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">Aime</h1>
            <p className="max-w-sm text-center text-muted">{t("app.tagline")}</p>
          </div>

          <div className="mt-10 grid grid-cols-2 gap-10">
            <section>
              <h2 className="text-[11px] font-semibold tracking-wider text-muted uppercase">
                {t("welcome.start")}
              </h2>
              <div className="mt-3 flex flex-col gap-2">
                <button
                  onClick={() => void openFolder()}
                  className="flex w-full items-center gap-2 rounded-lg bg-accent px-4 py-2 font-medium text-white hover:opacity-90"
                >
                  <FolderOpen size={16} /> {t("welcome.openFolder")}
                </button>
                <button onClick={() => void pickNewProjectLocation()} className={actionButton}>
                  <FolderPlus size={16} /> {t("welcome.newProject")}
                </button>
                <button
                  onClick={() => {
                    setCloneUrl("");
                  }}
                  disabled={cloning}
                  className={actionButton}
                  title={t("welcome.cloneHint")}
                >
                  {cloning ? <Loader2 size={16} className="animate-spin" /> : <GitBranch size={16} />}
                  {t("welcome.clone")}
                </button>
                <button
                  onClick={() => void openNewWindow()}
                  className={actionButton}
                  title={t("welcome.newWindowHint")}
                >
                  <AppWindow size={16} /> {t("welcome.newWindow")}
                </button>
              </div>
            </section>

            <section>
              <h2 className="text-[11px] font-semibold tracking-wider text-muted uppercase">
                {t("welcome.recent")}
              </h2>
              <div className="mt-3 flex flex-col gap-1">
                {folders.length === 0 && <p className="py-2 text-muted">{t("welcome.noRecent")}</p>}
                {folders.map((f) => (
                  <button
                    key={f.path}
                    onClick={() => void openRecent(f.path)}
                    title={f.path}
                    className="flex flex-col rounded-md px-2 py-1.5 text-left hover:bg-elevated"
                  >
                    <span className="font-medium text-accent">{folderNameOf(f.path)}</span>
                    <span className="truncate text-[11px] text-muted">{f.path}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>

          <EnvironmentCheck />
        </div>
      </div>

      {cloneUrl !== null && (
        <PromptModal
          title={t("modal.cloneTitle")}
          hint={t("modal.cloneHint")}
          initialValue=""
          onSubmit={(url) => {
            setCloneUrl(null);
            if (url.trim()) void cloneInto(url.trim());
          }}
          onClose={() => {
            setCloneUrl(null);
          }}
        />
      )}
      {newProjectParent && (
        <PromptModal
          title={t("modal.newProjectTitle")}
          hint={t("modal.newProjectHint")}
          initialValue=""
          onSubmit={(name) => {
            void createProject(name);
          }}
          onClose={() => {
            setNewProjectParent(null);
          }}
        />
      )}
    </div>
  );
}

/** The debugger keys, in the arrangement every editor has agreed on. */
const DEBUG_KEYS = new Set(["F5", "F10", "F11"]);

function runDebugShortcut(key: string, shift: boolean): void {
  const debug = useDebug.getState();
  if (key === "F5") {
    if (shift) {
      void debug.stop();
    } else if (debug.status.kind === "paused") {
      void debug.resume();
    } else if (debug.status.kind === "idle") {
      void debug.start();
    }
    return;
  }
  if (key === "F10") void debug.stepOver();
  if (key === "F11") void (shift ? debug.stepOut() : debug.stepInto());
}

export default function App() {
  const rootPath = useWorkspace((s) => s.rootPath);
  const { toggleSidebar, toggleAiPanel, toggleBottomPanel, helpOpen, toggleHelp, setHelpOpen } = useLayout();
  const { paletteOpen, togglePalette, setPaletteOpen } = useLayout();
  const { memoryOpen, setMemoryOpen, mcpOpen, setMcpOpen } = useLayout();
  const { installerTools, setInstallerTools } = useLayout();
  const { settingsOpen, setSettingsOpen } = useLayout();

  // `aime <folder>` launch: adopt the CLI folder unless the user beat us to the dialog.
  useEffect(() => {
    invoke<string | null>("initial_folder")
      .then((folder) => {
        if (folder && useWorkspace.getState().rootPath === null) {
          void useWorkspace.getState().adoptFolder(folder);
        }
      })
      .catch(console.error);
  }, []);

  // Bind the AI store to the workspace: restores this project's saved sessions.
  useEffect(() => {
    if (rootPath) void useAi.getState().hydrate(rootPath);
  }, [rootPath]);

  // Suppress the webview's default browser context menu — custom menus and
  // Monaco provide their own; editable fields keep the native one.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable='true'], .monaco-editor")) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);

  // Global shortcuts: Ctrl+Shift+N new window, Ctrl+B file tree, Ctrl+L AI panel,
  // Ctrl+` terminal, F1 help, and the debugger keys every editor shares
  // (F5 run/continue, Shift+F5 stop, F10/F11 step). F9 belongs to the editor,
  // which is the only thing that knows where the cursor is.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F1") {
        e.preventDefault();
        toggleHelp();
        return;
      }
      if (DEBUG_KEYS.has(e.key)) {
        e.preventDefault();
        runDebugShortcut(e.key, e.shiftKey);
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (e.shiftKey && key === "n") {
        e.preventDefault();
        void openNewWindow();
      } else if (key === "k" || key === "p") {
        e.preventDefault();
        togglePalette();
      } else if (key === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (key === "l") {
        e.preventDefault();
        toggleAiPanel();
      } else if (e.code === "Backquote") {
        e.preventDefault();
        toggleBottomPanel();
      } else if (e.key === ",") {
        // Ctrl+, is where every editor keeps its settings.
        e.preventDefault();
        useLayout.getState().setSettingsOpen(true);
      } else if (key === "w") {
        // Closes the current editor tab, not the window - the editor meaning
        // of Ctrl+W is the one a user has in their fingers here.
        const { openFilePath, closeTab } = useWorkspace.getState();
        if (openFilePath) {
          e.preventDefault();
          closeTab(openFilePath);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [toggleSidebar, toggleAiPanel, toggleBottomPanel, toggleHelp, togglePalette]);

  return (
    <div className="flex h-full flex-col">
      <UpdateNotice />
      <main className="min-h-0 flex-1">
        {rootPath ? (
          <Suspense fallback={<div className="h-full bg-bg" />}>
            <Workbench />
          </Suspense>
        ) : (
          <WelcomeScreen />
        )}
      </main>
      <StatusBar />
      {helpOpen && (
        <HelpModal
          onClose={() => {
            setHelpOpen(false);
          }}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          onClose={() => {
            setPaletteOpen(false);
          }}
        />
      )}
      {memoryOpen && (
        <MemoryModal
          onClose={() => {
            setMemoryOpen(false);
          }}
        />
      )}
      {mcpOpen && (
        <McpModal
          onClose={() => {
            setMcpOpen(false);
          }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          onClose={() => {
            setSettingsOpen(false);
          }}
        />
      )}
      {installerTools.length > 0 && (
        <InstallerModal
          tools={installerTools}
          onClose={() => {
            setInstallerTools([]);
          }}
        />
      )}
    </div>
  );
}
