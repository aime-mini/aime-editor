import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { Lightbulb, TriangleAlert, X } from "lucide-react";
import { Range as MonacoRange, type editor as MonacoEditor } from "monaco-editor";
import "../lib/monaco";
import { useT } from "../i18n";
import { AI_ACTIONS, buildPrompt, labelOf } from "../lib/aiActions";
import { languageOf } from "../lib/languages";
import { useAi } from "../stores/ai";
import { useLayout } from "../stores/layout";
import { useLsp } from "../stores/lsp";
import { useGit } from "../stores/git";
import { monacoThemeOf, useTheme } from "../stores/theme";
import { useSettings } from "../stores/settings";
import { useWorkspace } from "../stores/workspace";
import { ConflictView } from "./ConflictView";

/**
 * Offers the missing language server for the file in front of the user.
 *
 * A yellow dot in the status bar is easy to never notice; this appears exactly
 * when the gap matters - the moment a Python or Go file is open and typing
 * gives nothing - and disappears for good once dismissed for that language.
 */
function LanguageServerOffer({ languageId }: { languageId: string }) {
  const state = useLsp((s) => s.languages[languageId]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const t = useT();

  if (state?.kind !== "missing" || dismissed.includes(languageId)) return null;
  const runnable = !state.installHint.startsWith("http");

  return (
    <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-3 py-1 text-[12px]">
      <Lightbulb size={12} className="shrink-0 text-warn" />
      <span className="min-w-0 flex-1 truncate text-warn">
        {t("lsp.offer", { language: languageId, command: state.command })}
      </span>
      {runnable && (
        <button
          onClick={() => {
            useLayout.getState().setInstallerTools([languageId]);
          }}
          className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white hover:opacity-90"
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

/**
 * Puts the AI in the editor's own right-click menu.
 *
 * Registered on the editor instance rather than globally, so the actions know
 * which file they are in. With nothing selected they act on the whole file,
 * because "explain this file" is a question people ask just as often.
 */
function registerAiActions(editor: MonacoEditor.IStandaloneCodeEditor) {
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
  smoothScrolling: true,
  automaticLayout: true,
  scrollBeyondLastLine: false,
  padding: { top: 8 },
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

/** Read-only side-by-side diff of one file vs HEAD (opened from the Git panel). */
function DiffView({ relativePath }: { relativePath: string }) {
  const { rootPath, closeDiff } = useWorkspace();
  const theme = useTheme((s) => s.theme);
  const [original, setOriginal] = useState<string | null>(null);
  const [modified, setModified] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    if (!rootPath) return;
    let stale = false;
    const absolute = `${rootPath}/${relativePath}`;
    void Promise.all([
      invoke<string>("git_show_head", { root: rootPath, path: relativePath }),
      invoke<string>("read_file", { path: absolute }).catch(() => ""), // deleted in worktree
    ]).then(([head, working]) => {
      if (!stale) {
        setOriginal(head);
        setModified(working);
      }
    });
    return () => {
      stale = true;
    };
  }, [rootPath, relativePath]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-xs">
        <span className="truncate text-muted">{relativePath}</span>
        <span className="rounded bg-elevated px-1.5 text-[10px] text-muted">{t("git.diffLabel")}</span>
        <span className="flex-1" />
        <button onClick={closeDiff} className="rounded p-0.5 text-muted hover:bg-elevated hover:text-fg">
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {original !== null && modified !== null && (
          <DiffEditor
            original={original}
            modified={modified}
            language={languageOf(relativePath)}
            theme={monacoThemeOf(theme)}
            options={{ ...EDITOR_OPTIONS, readOnly: true, renderOverviewRuler: false }}
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
  const {
    openFilePath,
    diffPath,
    commitHash,
    conflictPath,
    blamePath,
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
      <LanguageServerOffer languageId={languageOf(openFilePath)} />
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
            registerAiActions(editor);
            decorationsRef.current = editor.createDecorationsCollection();
            blameDecoRef.current = editor.createDecorationsCollection();
            editor.onDidChangeCursorPosition((e) => {
              renderBlameForLine(e.position.lineNumber);
            });
          }}
          theme={monacoThemeOf(theme)}
          options={editorOptions}
        />
      </div>
    </div>
  );
}
