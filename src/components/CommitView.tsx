import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { useI18n, useT } from "../i18n";
import { whenText } from "../lib/workItems";
import { monacoThemeOf, useTheme } from "../stores/theme";
import { useWorkspace } from "../stores/workspace";

/**
 * One commit, read the way a commit is actually read.
 *
 * It used to be `git show --stat --patch` poured into one editor: a stat block
 * nobody can click followed by every file's patch concatenated. On a commit
 * touching twenty files that is a wall of text you scroll past looking for the
 * one file you came for.
 *
 * So: the message and who wrote it at the top, the files it touched as a list
 * with what happened to each, and the patch of whichever one is selected. The
 * patches are fetched one at a time, which is also why a hundred-file commit
 * opens instantly - nothing is read until it is asked for.
 */

/** Mirror of the Rust `CommitFile`. */
interface CommitFile {
  path: string;
  origPath: string | null;
  status: string;
  added: number;
  removed: number;
  binary: boolean;
}

/** Mirror of the Rust `CommitDetail`. */
interface CommitDetail {
  hash: string;
  subject: string;
  body: string;
  author: string;
  when: number;
  files: CommitFile[];
}

export function CommitView({ hash }: { hash: string }) {
  const { rootPath, closeDiff } = useWorkspace();
  const t = useT();
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (rootPath === null) return undefined;
    let stale = false;
    invoke<CommitDetail>("git_commit_detail", { root: rootPath, hash })
      .then((found) => {
        if (stale) return;
        setDetail(found);
        // Opening on the first file is what makes this a viewer rather than a
        // menu: the common commit touches one file, and it should be on screen.
        setSelected(found.files.at(0)?.path ?? null);
      })
      .catch((error: unknown) => {
        if (!stale) setProblem(String(error));
      });
    return () => {
      stale = true;
    };
  }, [rootPath, hash]);

  const file = detail?.files.find((candidate) => candidate.path === selected) ?? null;

  return (
    <div className="flex h-full flex-col">
      <Header detail={detail} hash={hash} onClose={closeDiff} />
      {problem !== null && <p className="text-danger px-3 py-2 text-[12px]">{problem}</p>}

      <div className="flex min-h-0 flex-1">
        {detail !== null && detail.files.length > 0 && (
          <nav className="w-64 shrink-0 overflow-y-auto border-r border-line bg-panel py-1">
            <p className="px-3 py-1 text-[10.5px] tracking-wide text-muted uppercase">
              {t("commit.files", { count: detail.files.length })}
            </p>
            {detail.files.map((entry) => (
              <FileRow
                key={entry.path}
                file={entry}
                selected={entry.path === selected}
                onSelect={() => {
                  setSelected(entry.path);
                }}
              />
            ))}
          </nav>
        )}
        <div className="min-h-0 min-w-0 flex-1">
          {/* Keyed by the file, so selecting another one starts from an empty
              view rather than showing the last patch while the new one loads. */}
          {file !== null && <Patch key={file.path} hash={hash} file={file} />}
          {detail !== null && detail.files.length === 0 && (
            <p className="p-4 text-[12px] text-muted">{t("commit.noFiles")}</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Who wrote it, when, and why - the part a stat block never told you. */
function Header({
  detail,
  hash,
  onClose,
}: {
  detail: CommitDetail | null;
  hash: string;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useI18n((state) => state.locale);
  return (
    <div className="border-b border-line bg-panel px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-[11.5px] text-accent">{hash.slice(0, 8)}</span>
        <h1 className="min-w-0 flex-1 truncate text-[13px] font-medium" title={detail?.subject}>
          {detail?.subject ?? t("commit.reading")}
        </h1>
        <button
          onClick={onClose}
          title={t("commit.close")}
          className="shrink-0 rounded p-0.5 text-muted hover:bg-elevated hover:text-fg"
        >
          <X size={13} />
        </button>
      </div>
      {detail !== null && (
        <p className="mt-0.5 text-[11px] text-muted">
          {detail.author}
          {detail.when > 0 && ` · ${whenText(String(detail.when * 1000), locale)}`}
        </p>
      )}
      {detail !== null && detail.body !== "" && (
        <pre className="mt-1.5 max-h-24 overflow-y-auto text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg/80">
          {detail.body}
        </pre>
      )}
    </div>
  );
}

/** One file in the list: what happened to it, and how much of it moved. */
function FileRow({
  file,
  selected,
  onSelect,
}: {
  file: CommitFile;
  selected: boolean;
  onSelect: () => void;
}) {
  const name = file.path.split("/").pop() ?? file.path;
  const folder = file.path.slice(0, file.path.length - name.length);
  return (
    <button
      onClick={onSelect}
      title={file.origPath === null ? file.path : `${file.origPath} → ${file.path}`}
      className={`flex w-full items-baseline gap-1.5 px-3 py-1 text-left hover:bg-elevated ${
        selected ? "bg-elevated" : ""
      }`}
    >
      <span className={`w-3 shrink-0 text-center font-mono text-[11px] ${STATUS_COLOURS[file.status] ?? ""}`}>
        {file.status}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px]">
        {/* The folder is context, the name is the thing being looked for. */}
        {folder !== "" && <span className="text-muted">{folder}</span>}
        <span className={selected ? "text-accent" : ""}>{name}</span>
      </span>
      {file.binary ? (
        <span className="shrink-0 text-[10px] text-muted">bin</span>
      ) : (
        <span className="shrink-0 font-mono text-[10px] tabular-nums">
          {file.added > 0 && <span className="text-ok">+{file.added}</span>}
          {file.removed > 0 && <span className="text-danger"> −{file.removed}</span>}
        </span>
      )}
    </button>
  );
}

/** Git's own letters, coloured the way the Git panel colours them. */
const STATUS_COLOURS: Record<string, string> = {
  A: "text-ok",
  D: "text-danger",
  M: "text-accent",
  R: "text-warn",
  C: "text-warn",
  T: "text-warn",
};

/** The patch of the selected file, fetched when it is selected and not before. */
function Patch({ hash, file }: { hash: string; file: CommitFile }) {
  const rootPath = useWorkspace((state) => state.rootPath);
  const theme = useTheme((state) => state.theme);
  const t = useT();
  const [patch, setPatch] = useState<string | null>(null);

  useEffect(() => {
    if (rootPath === null) return undefined;
    let stale = false;
    // Both names for a rename: with only the new one git cannot pair the two and
    // prints the file as freshly added rather than as moved.
    invoke<string>("git_show_commit_file", {
      root: rootPath,
      hash,
      path: file.path,
      origPath: file.origPath,
    })
      .then((text) => {
        if (!stale) setPatch(text);
      })
      .catch((error: unknown) => {
        if (!stale) setPatch(String(error));
      });
    return () => {
      stale = true;
    };
  }, [rootPath, hash, file.path, file.origPath]);

  if (file.binary) return <p className="p-4 text-[12px] text-muted">{t("commit.binary")}</p>;
  if (patch === null) return <p className="p-4 text-[12px] text-muted">{t("commit.reading")}</p>;
  // An empty answer is a thing that happened, not a thing to render: an editor
  // holding nothing looks exactly like an editor that failed to load, and the
  // reader has no way to tell which they are looking at.
  if (patch.trim() === "") return <p className="p-4 text-[12px] text-muted">{t("commit.noPatch")}</p>;

  return (
    <Editor
      value={patch}
      language="aime-diff"
      theme={monacoThemeOf(theme)}
      options={{
        fontFamily: "JetBrains Mono, Consolas, monospace",
        smoothScrolling: false,
        automaticLayout: true,
        scrollBeyondLastLine: false,
        padding: { top: 8 },
        readOnly: true,
        wordWrap: "off",
        minimap: { enabled: false },
        // A patch has no outline to pin, and no breakpoints to hold.
        stickyScroll: { enabled: false },
        glyphMargin: false,
      }}
    />
  );
}
