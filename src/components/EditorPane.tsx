import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { Lightbulb, Sparkles, TriangleAlert, X } from "lucide-react";
import { KeyCode, KeyMod, Range as MonacoRange, type editor as MonacoEditor } from "monaco-editor";
import "../lib/monaco";
import { translate, useT } from "../i18n";
import { AI_ACTIONS, buildPrompt, labelOf } from "../lib/aiActions";
import { registerInlineAi } from "../lib/aiInline";
import { installableDebugger } from "../lib/dap/availability";
import { LANGUAGES_MONACO_OUTLINES, languageOf } from "../lib/languages";
import { setActiveEditor } from "../lib/monacoAccess";
import { useAi } from "../stores/ai";
import { useDebug } from "../stores/debug";
import { useLayout } from "../stores/layout";
import { useLsp } from "../stores/lsp";
import { useGit } from "../stores/git";
import { useSetup } from "../stores/setup";
import { monacoThemeOf, useTheme } from "../stores/theme";
import { useSettings } from "../stores/settings";
import { useWorkspace } from "../stores/workspace";
import { ConflictView } from "./ConflictView";
import { RunView } from "./RunView";
import { WorkItemView } from "./WorkItemView";
import { DebugToolbar } from "./DebugToolbar";
import { useDebugGutter } from "./useDebugGutter";

/**
 * Offers to close whatever gap this file's language has.
 *
 * Three kinds of gap, one banner: a language server that is not installed (no
 * completions, no types), one that is installed but failed to start (same
 * symptom, and previously the one case with no offer at all — the user just
 * typed into silence), and a debug adapter this machine has to provide (F5
 * does nothing). It appears exactly when the gap matters — the moment such a
 * file is open — and stays gone once dismissed for that language.
 *
 * It says nothing about debugging any other kind of file, and that is the whole
 * design: `installableDebugger` answers only for a language Aime drives an
 * adapter for, so a Markdown file, a stylesheet or a language whose adapter
 * Aime has not shipped yet gets no offer that an install could not deliver.
 *
 * The AI button is the point of an AI editor: Aime knows precisely what it
 * probed for and did not find, so it hands the agent that brief and lets it
 * work out this machine's toolchain, install what is missing and verify it,
 * instead of showing the user a documentation link. "Install it" stays for the
 * case where Aime already knows the one command to run — that is faster, and it
 * costs no tokens.
 */
function SetupOffer({ languageId, relativePath }: { languageId: string; relativePath: string }) {
  const server = useLsp((s) => s.languages[languageId]);
  const adapter = useDebug((s) => s.adapters[languageId]);
  const probeAdapter = useDebug((s) => s.probeAdapter);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const t = useT();

  // The banner cannot say a debugger is missing without having asked.
  useEffect(() => {
    void probeAdapter(languageId);
  }, [languageId, probeAdapter]);

  const serverMissing = server?.kind === "missing";
  const serverFailed = server?.kind === "failed";
  const missingDebugger = installableDebugger(adapter);
  if (dismissed.includes(languageId) || (!serverMissing && !serverFailed && missingDebugger === null)) {
    return null;
  }

  // "Install it" only when the install could actually run: without Go on the
  // machine, `go install …` is a spawn failure dressed as an offer, and that gap
  // is the agent's to close. A failed server never gets it — it is installed
  // already, and reinstalling is the one fix known not to be the fix.
  const runnable = serverMissing && server.installable;
  const summary = serverMissing
    ? t("lsp.offer", { language: languageId, command: server.command })
    : serverFailed
      ? t("lsp.offerFailed", { language: languageId, command: server.command })
      : t("setup.debuggerOnly", { language: languageId });

  return (
    <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-3 py-1 text-[12px]">
      <Lightbulb size={12} className="shrink-0 text-warn" />
      <span className="min-w-0 flex-1 truncate text-warn">{summary}</span>
      <button
        onClick={() => {
          // Its own run, with its own progress modal - not the chat panel. A
          // setup turn can last a quarter of an hour, and it must not spend the
          // user's conversation or bury their own thread while it does.
          void useSetup.getState().start({
            languageId,
            relativePath,
            serverCommand: serverMissing ? server.command : null,
            serverInstallHint: serverMissing ? server.installHint : null,
            failedServer: serverFailed ? { command: server.command, reason: server.reason } : null,
            missingDebugger,
            // No adapter at all: an install cannot help, but being taught one
            // can - so the agent gets the contract for writing it down.
            teachDebugger: adapter === null,
          });
          // The agent works in the open; this banner has said its piece.
          setDismissed((current) => [...current, languageId]);
        }}
        title={t("setup.aiHint")}
        className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent-strong px-2.5 py-1 text-[11.5px] font-medium text-white hover:opacity-90"
      >
        <Sparkles size={11} /> {t("setup.ai")}
      </button>
      {runnable && (
        <button
          onClick={() => {
            useLayout.getState().setInstallerTools([languageId]);
          }}
          className="shrink-0 rounded-md border border-line px-2.5 py-1 text-[11.5px] font-medium text-muted hover:text-fg"
        >
          {t("lsp.offerInstall")}
        </button>
      )}
      <button
        onClick={() => {
          setDismissed((current) => [...current, languageId]);
        }}
        title={t("lsp.offerDismiss")}
        className="shrink-0 rounded p-1 text-muted hover:text-fg"
      >
        <X size={11} />
      </button>
    </div>
  );
}

/** Tab label: the file name, which is what the user recognizes. */
function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** One tab per open file: name, unsaved dot, close on hover or middle-click. */
function EditorTabs() {
  const { openTabs, openFilePath, buffers, dirty, activateTab, closeTab } = useWorkspace();
  const t = useT();
  if (openTabs.length === 0) return null;

  const isDirty = (path: string) =>
    path === openFilePath
      ? dirty
      : (() => {
          const buffer = buffers[path];
          return buffer ? buffer.content !== buffer.savedContent : false;
        })();

  return (
    <div className="flex items-stretch gap-0.5 overflow-x-auto border-b border-line bg-panel px-1 pt-1">
      {openTabs.map((path) => {
        const active = path === openFilePath;
        return (
          <div
            key={path}
            onClick={() => {
              activateTab(path);
            }}
            onAuxClick={(e) => {
              // Middle-click closes, the way every editor does it.
              if (e.button === 1) {
                e.preventDefault();
                closeTab(path);
              }
            }}
            title={path}
            className={`group flex max-w-52 shrink-0 items-center gap-1.5 rounded-t px-2 py-1 text-[11.5px] ${
              active ? "bg-elevated text-fg" : "cursor-pointer text-muted hover:bg-elevated/50"
            }`}
          >
            <span className="truncate">{fileNameOf(path)}</span>
            {isDirty(path) && <span className="size-1.5 shrink-0 rounded-full bg-accent" />}
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(path);
              }}
              title={t("editor.closeTab")}
              className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-panel hover:text-danger"
            >
              <X size={10} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Set while the open file is one Aime could stop inside; gates F9 below. */
const DEBUGGABLE_FILE = "aimeFileIsDebuggable";

/**
 * F9 on the cursor line, the shortcut the gutter click has in every editor.
 *
 * Both the key and the context-menu entry are withdrawn in a file Aime drives
 * no adapter for — a breakpoint could never bind there, and offering the
 * gesture only to refuse it is how a README ends up looking debuggable. The
 * returned key starts out true: until the probe has answered, being able to set
 * a breakpoint in a program file matters more than hiding one in a document.
 */
function registerBreakpointAction(
  editor: MonacoEditor.IStandaloneCodeEditor,
): MonacoEditor.IContextKey<boolean> {
  const debuggable = editor.createContextKey<boolean>(DEBUGGABLE_FILE, true);
  editor.addAction({
    id: "aime.debug.editBreakpointRule",
    label: translate("debug.ruleAction"),
    // Shift+F9 is where every editor puts a conditional breakpoint.
    keybindings: [KeyMod.Shift | KeyCode.F9],
    precondition: DEBUGGABLE_FILE,
    contextMenuGroupId: "debug",
    contextMenuOrder: 1,
    run: (instance) => {
      const path = useWorkspace.getState().openFilePath;
      const line = instance.getPosition()?.lineNumber;
      if (path && line !== undefined) void useDebug.getState().editBreakpointRule(path, line);
    },
  });
  editor.addAction({
    id: "aime.debug.toggleBreakpoint",
    label: translate("debug.toggleBreakpoint"),
    keybindings: [KeyCode.F9],
    precondition: DEBUGGABLE_FILE,
    contextMenuGroupId: "debug",
    run: (instance) => {
      const path = useWorkspace.getState().openFilePath;
      const line = instance.getPosition()?.lineNumber;
      if (path && line !== undefined) void useDebug.getState().toggleBreakpoint(path, line);
    },
  });
  return debuggable;
}

/**
 * The command palette, from inside the editor.
 *
 * Monaco owns `Ctrl+K` as a chord prefix and stops the event before the window
 * handler sees it, so without this the palette simply would not open while the
 * cursor was in a file - which is most of the time. Registered as an editor
 * action for the same reason F9 is: the editor is where the keystroke lands.
 */
function registerPaletteAction(editor: MonacoEditor.IStandaloneCodeEditor) {
  editor.addAction({
    id: "aime.palette",
    label: translate("cmd.palette"),
    keybindings: [KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyP],
    run: () => {
      useLayout.getState().togglePalette();
    },
  });
}

/**
 * Puts the AI in the editor's own right-click menu.
 *
 * Registered on the editor instance rather than globally, so the actions know
 * which file they are in. With nothing selected they act on the whole file,
 * because "explain this file" is a question people ask just as often.
 */
function registerAiActions(editor: MonacoEditor.IStandaloneCodeEditor) {
  editor.addAction({
    id: "aime.ai.suggest",
    label: translate("ai.suggestHere"),
    // Ctrl+Alt+Space: Ctrl+Space is taken by the language server's completions,
    // and the two answer different questions.
    keybindings: [KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Space],
    contextMenuGroupId: "aime-ai",
    contextMenuOrder: -1,
    run: (instance) => {
      instance.trigger("aime", "editor.action.inlineSuggest.trigger", {});
    },
  });
  for (const action of AI_ACTIONS) {
    editor.addAction({
      id: `aime.ai.${action.id}`,
      label: labelOf(action),
      contextMenuGroupId: "aime-ai",
      contextMenuOrder: AI_ACTIONS.indexOf(action),
      run: (instance) => {
        const model = instance.getModel();
        const { rootPath, openFilePath } = useWorkspace.getState();
        if (!model || !rootPath || !openFilePath) return;

        const selection = instance.getSelection();
        const selected = selection && !selection.isEmpty() ? model.getValueInRange(selection) : "";
        const relative = openFilePath.startsWith(rootPath)
          ? openFilePath.slice(rootPath.length + 1)
          : openFilePath;

        useLayout.getState().setAiPanelVisible(true);
        void useAi
          .getState()
          .sendPrompt(buildPrompt(action, relative, selected, model.getLanguageId()), rootPath);
      },
    });
  }
}

/** Everything that is not a user preference. */
const EDITOR_OPTIONS = {
  fontFamily: "JetBrains Mono, Consolas, monospace",
  // Off, as in VS Code (`editor.smoothScrolling` defaults to false): the
  // animation smears every wheel tick over ~125ms of repaints, which hides
  // nothing on a fast machine and turns dropped frames into visible judder on
  // a loaded one — scrolling should land where the hand put it, immediately.
  smoothScrolling: false,
  automaticLayout: true,
  scrollBeyondLastLine: false,
  padding: { top: 8 },
  // The strip breakpoints live in. Always on: a margin that appears with the
  // first breakpoint would shift the whole file sideways as it is set.
  glyphMargin: true,
  // Off here, and turned on per file by the main editor when that file has an
  // outline (see `hasOutline` in EditorPane). Monaco's own default is on, but
  // without an outline it falls back to reading indentation, which pins five
  // rows of bare `{` over a file whose braces sit on their own line. The read-only
  // views below - a diff, a patch - keep it off: neither has an outline to pin.
  stickyScroll: { enabled: false },
} as const;

/** Editor options as the user's settings make them. */
function useEditorOptions() {
  const { fontSize, wordWrap, minimap, tabSize } = useSettings();
  return {
    ...EDITOR_OPTIONS,
    fontSize,
    tabSize,
    wordWrap: wordWrap ? ("on" as const) : ("off" as const),
    minimap: { enabled: minimap },
  };
}

interface GutterRange {
  start: number;
  end: number;
  kind: "added" | "modified" | "deleted";
}

/** Parses `git diff -U0` hunk headers (@@ -a,b +c,d @@) into gutter ranges. */
function parseHunks(diff: string): GutterRange[] {
  const ranges: GutterRange[] = [];
  const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  for (let match = hunk.exec(diff); match !== null; match = hunk.exec(diff)) {
    // Optional capture groups are undefined at runtime even though TS types them as string.
    const [, removedStr, startStr, addedStr] = match as unknown as (string | undefined)[];
    const removed = removedStr === undefined ? 1 : Number(removedStr);
    const start = Number(startStr);
    const added = addedStr === undefined ? 1 : Number(addedStr);
    if (added === 0) {
      ranges.push({ start: Math.max(1, start), end: Math.max(1, start), kind: "deleted" });
    } else {
      ranges.push({ start, end: start + added - 1, kind: removed === 0 ? "added" : "modified" });
    }
  }
  return ranges;
}

/**
 * The two sides of a diff, tagged with the file they were read for.
 *
 * The tag is what keeps a slow answer for the file that was open a moment ago
 * from being painted under the name of the one that is open now.
 */
interface DiffSides {
  path: string;
  head: string;
  working: string;
}

/**
 * Read-only side-by-side diff of one file vs HEAD (opened from the Git panel).
 *
 * Three things here exist so that a change git listed is a change the user can
 * actually see, which is not what a plain diff editor gives you:
 *
 * - It re-reads when the worktree or HEAD moves, not only when another file is
 *   picked. Without that, editing the file and coming back showed the snapshot
 *   taken the first time - and clicking the same row again changed nothing,
 *   because nothing about the view's inputs had changed.
 * - `ignoreTrimWhitespace` is off. Monaco defaults it to on, which hides a
 *   change that only moved indentation - while the panel next to it keeps
 *   listing the file as modified.
 * - It scrolls to the first difference. A long file opens on two identical
 *   panes otherwise, and the overview ruler is left on as the map of the rest.
 */
function DiffView({ relativePath }: { relativePath: string }) {
  const { rootPath, closeDiff, treeVersion } = useWorkspace();
  const theme = useTheme((s) => s.theme);
  // The worktree side goes stale with any file change (treeVersion), the HEAD
  // side when the last commit moves - together they are "is this still true?".
  const headCommit = useGit((s) => s.log[0]?.hash);
  const [sides, setSides] = useState<DiffSides | null>(null);
  const [sameText, setSameText] = useState(false);
  const diffRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
  const t = useT();

  useEffect(() => {
    if (!rootPath) return;
    let stale = false;
    const absolute = `${rootPath}/${relativePath}`;
    void Promise.all([
      invoke<string>("git_show_head", { root: rootPath, path: relativePath }),
      invoke<string>("read_file", { path: absolute }).catch(() => ""), // deleted in worktree
    ]).then(([head, working]) => {
      if (!stale) setSides({ path: relativePath, head, working });
    });
    return () => {
      stale = true;
    };
  }, [rootPath, relativePath, treeVersion, headCommit]);

  // New content means a new diff to land on. `revealFirstDiff` waits for the
  // computation itself, so this is safe the moment the sides arrive.
  useEffect(() => {
    if (sides) diffRef.current?.revealFirstDiff();
  }, [sides]);

  const shown = sides?.path === relativePath ? sides : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-xs">
        <span className="truncate text-muted">{relativePath}</span>
        <span className="rounded bg-elevated px-1.5 text-[10px] text-muted">{t("git.diffLabel")}</span>
        {/* Git listed this file, so an empty diff is a question the view has to
            answer rather than leave the user hunting for a change on screen. */}
        {shown !== null && sameText && (
          <span title={t("git.diffSameHint")} className="rounded bg-elevated px-1.5 text-[10px] text-warn">
            {t("git.diffSame")}
          </span>
        )}
        <span className="flex-1" />
        <button onClick={closeDiff} className="rounded p-0.5 text-muted hover:bg-elevated hover:text-fg">
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {shown !== null && (
          <DiffEditor
            original={shown.head}
            modified={shown.working}
            language={languageOf(relativePath)}
            theme={monacoThemeOf(theme)}
            onMount={(editor) => {
              diffRef.current = editor;
              editor.onDidUpdateDiff(() => {
                setSameText((editor.getLineChanges() ?? []).length === 0);
              });
              editor.revealFirstDiff();
            }}
            options={{ ...EDITOR_OPTIONS, readOnly: true, ignoreTrimWhitespace: false }}
          />
        )}
      </div>
    </div>
  );
}

/** Read-only patch of one commit (opened from the Git history list). */
function CommitView({ hash }: { hash: string }) {
  const { rootPath, closeDiff } = useWorkspace();
  const theme = useTheme((s) => s.theme);
  const [patch, setPatch] = useState<string | null>(null);

  useEffect(() => {
    if (!rootPath) return;
    let stale = false;
    invoke<string>("git_show_commit", { root: rootPath, hash })
      .then((text) => {
        if (!stale) setPatch(text);
      })
      .catch((err: unknown) => {
        if (!stale) setPatch(String(err));
      });
    return () => {
      stale = true;
    };
  }, [rootPath, hash]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-xs">
        <span className="font-mono text-accent">{hash.slice(0, 8)}</span>
        <span className="flex-1" />
        <button onClick={closeDiff} className="rounded p-0.5 text-muted hover:bg-elevated hover:text-fg">
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {patch !== null && (
          <Editor
            value={patch}
            language="aime-diff"
            theme={monacoThemeOf(theme)}
            options={{ ...EDITOR_OPTIONS, readOnly: true, wordWrap: "off" }}
          />
        )}
      </div>
    </div>
  );
}

interface BlameLine {
  sha: string;
  author: string;
  time: number;
  summary: string;
}

function isUncommitted(line: BlameLine): boolean {
  return line.time === 0 || line.sha.startsWith("00000000");
}

function formatBlame(line: BlameLine): string {
  if (isUncommitted(line)) return ` • ${line.author}`;
  const date = new Date(line.time * 1000).toLocaleDateString();
  return ` • ${line.author}, ${date} - ${line.summary}`;
}

/** Full-file blame: every line with its commit, author, and date — click a
 *  commit to open its patch. Opened from the file tree context menu. */
function BlameView({ relativePath }: { relativePath: string }) {
  const { rootPath, closeDiff, openCommit } = useWorkspace();
  const [blame, setBlame] = useState<BlameLine[] | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const t = useT();

  useEffect(() => {
    if (!rootPath) return;
    let stale = false;
    void Promise.all([
      invoke<BlameLine[]>("git_blame", { root: rootPath, path: relativePath }),
      invoke<string>("read_file", { path: `${rootPath}/${relativePath}` }).catch(() => ""),
    ]).then(([blameLines, content]) => {
      if (stale) return;
      setBlame(blameLines);
      setLines(content.split("\n"));
    });
    return () => {
      stale = true;
    };
  }, [rootPath, relativePath]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-xs">
        <span className="truncate text-muted">{relativePath}</span>
        <span className="rounded bg-elevated px-1.5 text-[10px] text-muted">{t("git.blameLabel")}</span>
        <span className="flex-1" />
        <button onClick={closeDiff} className="rounded p-0.5 text-muted hover:bg-elevated hover:text-fg">
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px]">
        {blame !== null &&
          lines.map((text, i) => {
            const info = blame[i] as BlameLine | undefined;
            const prev = i > 0 ? (blame[i - 1] as BlameLine | undefined) : undefined;
            const newCommit = info !== undefined && (prev === undefined || prev.sha !== info.sha);
            return (
              <div
                // Line order is the identity here; the list is never reordered.
                key={i}
                className={`flex items-stretch whitespace-pre ${newCommit ? "border-t border-line/60" : ""}`}
              >
                <button
                  disabled={info === undefined || isUncommitted(info)}
                  onClick={() => {
                    if (info) openCommit(info.sha);
                  }}
                  title={info ? `${info.author} - ${info.summary}` : ""}
                  className="w-40 shrink-0 truncate px-2 text-left text-muted hover:text-accent disabled:cursor-default"
                >
                  {info !== undefined &&
                    newCommit &&
                    (isUncommitted(info) ? t("git.uncommitted") : `${info.sha.slice(0, 8)} ${info.author}`)}
                </button>
                <span className="w-20 shrink-0 truncate pr-2 text-right text-[10px] leading-[18px] text-muted/70">
                  {info !== undefined && newCommit && !isUncommitted(info)
                    ? new Date(info.time * 1000).toLocaleDateString()
                    : ""}
                </span>
                <span className="w-8 shrink-0 pr-2 text-right text-muted/50">{i + 1}</span>
                <span className="min-w-0 flex-1">{text}</span>
              </div>
            );
          })}
      </div>
    </div>
  );
}

export function EditorPane() {
  const editorOptions = useEditorOptions();
  const inlineAi = useSettings((s) => s.inlineAi);
  const {
    openFilePath,
    diffPath,
    commitHash,
    conflictPath,
    blamePath,
    workItemId,
    runOpen,
    fileContent,
    dirty,
    rootPath,
    treeVersion,
    setContent,
    saveFile,
  } = useWorkspace();
  const theme = useTheme((s) => s.theme);
  const t = useT();
  const openConflict = useWorkspace((s) => s.openConflict);
  const gitFiles = useGit((s) => s.status?.files);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  const blameRef = useRef<BlameLine[]>([]);
  const blameDecoRef = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  // Held in state as well as in the ref: the debug gutter is an effect, and an
  // effect cannot know a ref was filled in without a render to tell it.
  const [editorInstance, setEditorInstance] = useState<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const debuggableRef = useRef<MonacoEditor.IContextKey<boolean> | null>(null);

  useDebugGutter(editorInstance, openFilePath);

  const openLanguage = openFilePath === null ? null : languageOf(openFilePath);
  // `null` is the probe's answer for a language Aime drives no adapter for, and
  // the only one that withdraws F9. Re-run on a new editor too: a remount
  // creates a fresh context key, back at its permissive default.
  const adapterProbe = useDebug((s) => (openLanguage === null ? undefined : s.adapters[openLanguage]));
  useEffect(() => {
    debuggableRef.current?.set(adapterProbe !== null);
  }, [adapterProbe, editorInstance]);

  /**
   * Sticky scroll pins the scope you are inside, read from the file's outline -
   * so it is on exactly when this file has one. Monaco falls back to indentation
   * otherwise, and a language that puts its braces on their own line then pins
   * five rows of bare `{` over the code, which reads as a rendering glitch.
   */
  const openServer = useLsp((s) => (openLanguage === null ? undefined : s.languages[openLanguage]));
  const hasOutline =
    (openServer?.kind === "running" && openServer.outline) ||
    (openLanguage !== null && LANGUAGES_MONACO_OUTLINES.has(openLanguage));

  const relativeOpenPath =
    openFilePath && rootPath ? openFilePath.slice(rootPath.length + 1).replaceAll("\\", "/") : null;
  const openFileConflicted =
    relativeOpenPath !== null &&
    (gitFiles ?? []).some((file) => file.conflicted && file.path === relativeOpenPath);

  /** GitLens-style inline blame on the cursor line only — subtle, zero-config. */
  const renderBlameForLine = useCallback((lineNumber: number) => {
    // Index access can miss (file longer than blame data, blame not loaded yet).
    const info = blameRef.current[lineNumber - 1] as BlameLine | undefined;
    const editor = editorRef.current;
    if (!editor || !blameDecoRef.current) return;
    if (!info) {
      blameDecoRef.current.clear();
      return;
    }
    const column = editor.getModel()?.getLineMaxColumn(lineNumber) ?? 1;
    blameDecoRef.current.set([
      {
        range: new MonacoRange(lineNumber, column, lineNumber, column),
        options: { after: { content: formatBlame(info), inlineClassName: "blame-inline" } },
      },
    ]);
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void saveFile();
      }
    },
    [saveFile],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onKeyDown]);

  // Git gutter marks: refreshed when the open file or the workspace changes.
  useEffect(() => {
    if (!openFilePath || !rootPath) return;
    const relative = openFilePath.slice(rootPath.length + 1).replaceAll("\\", "/");
    let stale = false;
    invoke<string>("git_file_diff", { root: rootPath, path: relative })
      .then((diff) => {
        if (stale) return;
        const decorations = parseHunks(diff).map((range) => ({
          range: new MonacoRange(range.start, 1, range.end, 1),
          options: { isWholeLine: true, linesDecorationsClassName: `git-gutter-${range.kind}` },
        }));
        decorationsRef.current?.set(decorations);
      })
      .catch(() => {
        // Not a repo / git unavailable — gutter simply stays empty.
      });
    return () => {
      stale = true;
    };
  }, [openFilePath, rootPath, treeVersion]);

  // Blame data for the open file; the cursor listener renders it per line.
  useEffect(() => {
    blameRef.current = [];
    blameDecoRef.current?.clear();
    if (!openFilePath || !rootPath) return;
    const relative = openFilePath.slice(rootPath.length + 1).replaceAll("\\", "/");
    let stale = false;
    invoke<BlameLine[]>("git_blame", { root: rootPath, path: relative })
      .then((blame) => {
        if (stale) return;
        blameRef.current = blame;
        const position = editorRef.current?.getPosition();
        if (position) renderBlameForLine(position.lineNumber);
      })
      .catch(() => {
        // Not a repo — blame simply stays off.
      });
    return () => {
      stale = true;
    };
  }, [openFilePath, rootPath, treeVersion, renderBlameForLine]);

  if (runOpen) {
    // A run owns the area while it goes: it is minutes of work with evidence
    // to read, not a dialog to dismiss.
    return <RunView />;
  }

  if (workItemId) {
    // Keyed by the item, so opening another one starts from a clean view
    // instead of showing the previous item's text while the new one loads.
    return <WorkItemView key={workItemId} itemId={workItemId} />;
  }

  if (conflictPath) {
    return <ConflictView relativePath={conflictPath} />;
  }

  if (blamePath) {
    return <BlameView relativePath={blamePath} />;
  }

  if (commitHash) {
    return <CommitView hash={commitHash} />;
  }

  if (diffPath) {
    return <DiffView relativePath={diffPath} />;
  }

  if (!openFilePath) {
    return <div className="flex h-full items-center justify-center text-muted">{t("editor.pickFile")}</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-xs">
        <span className="truncate text-muted">{openFilePath}</span>
        {dirty && <span className="size-2 shrink-0 rounded-full bg-accent" title={t("editor.unsavedHint")} />}
        <span className="flex-1" />
        <DebugToolbar />
      </div>
      {openFileConflicted && (
        <button
          onClick={() => {
            openConflict(relativeOpenPath);
          }}
          className="flex items-center gap-1.5 border-b border-danger/40 bg-danger/10 px-3 py-1 text-left text-[12px] text-danger hover:bg-danger/20"
        >
          <TriangleAlert size={12} className="shrink-0" />
          {t("editor.conflictBanner")} — {t("git.resolve")}
        </button>
      )}
      <EditorTabs />
      {relativeOpenPath !== null && (
        <SetupOffer languageId={languageOf(openFilePath)} relativePath={relativeOpenPath} />
      )}
      <div className="min-h-0 flex-1">
        <Editor
          path={openFilePath}
          language={languageOf(openFilePath)}
          value={fileContent}
          onChange={(v) => {
            setContent(v ?? "");
          }}
          onMount={(editor) => {
            editorRef.current = editor;
            setEditorInstance(editor);
            // Published for the few things that need a real editor - a plugin's
            // edit goes through Monaco so Ctrl+Z takes it back.
            setActiveEditor(editor);
            registerInlineAi();
            registerAiActions(editor);
            debuggableRef.current = registerBreakpointAction(editor);
            registerPaletteAction(editor);
            decorationsRef.current = editor.createDecorationsCollection();
            blameDecoRef.current = editor.createDecorationsCollection();
            editor.onDidChangeCursorPosition((e) => {
              renderBlameForLine(e.position.lineNumber);
            });
          }}
          theme={monacoThemeOf(theme)}
          options={{
            ...editorOptions,
            inlineSuggest: { enabled: inlineAi !== "off" },
            stickyScroll: { enabled: hasOutline },
          }}
        />
      </div>
    </div>
  );
}
