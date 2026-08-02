import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { TriangleAlert, X } from "lucide-react";
import { Range as MonacoRange, type editor as MonacoEditor } from "monaco-editor";
import "../lib/monaco";
import { useT } from "../i18n";
import { languageOf } from "../lib/languages";
import { useGit } from "../stores/git";
import { monacoThemeOf, useTheme } from "../stores/theme";
import { useWorkspace } from "../stores/workspace";
import { ConflictView } from "./ConflictView";

const EDITOR_OPTIONS = {
  fontFamily: "JetBrains Mono, Consolas, monospace",
  fontSize: 13,
  minimap: { enabled: false },
  smoothScrolling: true,
  automaticLayout: true,
  scrollBeyondLastLine: false,
  padding: { top: 8 },
} as const;

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
            decorationsRef.current = editor.createDecorationsCollection();
            blameDecoRef.current = editor.createDecorationsCollection();
            editor.onDidChangeCursorPosition((e) => {
              renderBlameForLine(e.position.lineNumber);
            });
          }}
          theme={monacoThemeOf(theme)}
          options={EDITOR_OPTIONS}
        />
      </div>
    </div>
  );
}
