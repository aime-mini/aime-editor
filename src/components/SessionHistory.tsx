import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, MessageSquare, Pencil, X } from "lucide-react";
import { useT } from "../i18n";
import { MENU_MARGIN, placeMenu, type Placement } from "../lib/menuPlacement";
import { sessionLabel, type StoredSession } from "../stores/ai";

interface SessionHistoryProps {
  x: number;
  y: number;
  sessions: StoredSession[];
  /** The session the panel shows now, marked in the list. */
  liveId: string;
  /** Opening another session is refused while a turn runs; naming one is not. */
  canOpen: boolean;
  onOpen: (localId: string) => void;
  onRename: (localId: string, name: string) => void;
  onClose: () => void;
}

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The project's saved conversations, each of which can be opened or named.
 * A name is what tells twenty sessions that all began with "continue" apart,
 * so it is given right where the sessions are picked from.
 */
export function SessionHistory({
  x,
  y,
  sessions,
  liveId,
  canOpen,
  onOpen,
  onRename,
  onClose,
}: SessionHistoryProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement>({ left: x, top: y });
  const [editing, setEditing] = useState<string | null>(null);

  // While a name is being typed, Escape belongs to the name box.
  useEffect(() => {
    if (editing !== null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [editing, onClose]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPlacement(
      placeMenu(
        { x, y },
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [x, y, sessions.length]);

  return (
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      <div
        ref={ref}
        role="menu"
        aria-label={t("ai.history")}
        style={{
          left: placement.left,
          top: placement.top,
          maxHeight: `calc(100vh - ${String(MENU_MARGIN * 2)}px)`,
        }}
        className="absolute flex w-[min(26rem,90vw)] flex-col overflow-y-auto rounded-lg border border-line bg-elevated py-1 shadow-xl"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        {sessions.length === 0 ? (
          <div className="px-3 py-1.5 text-muted">{t("ai.historyEmpty")}</div>
        ) : (
          sessions.map((session) =>
            editing === session.localId ? (
              <SessionNameEditor
                key={session.localId}
                initial={session.name ?? ""}
                placeholder={session.title}
                onDone={(name) => {
                  if (name !== null) onRename(session.localId, name);
                  setEditing(null);
                }}
              />
            ) : (
              <SessionRow
                key={session.localId}
                session={session}
                live={session.localId === liveId}
                canOpen={canOpen}
                onOpen={() => {
                  onClose();
                  onOpen(session.localId);
                }}
                onRename={() => {
                  setEditing(session.localId);
                }}
              />
            ),
          )
        )}
      </div>
    </div>
  );
}

interface SessionRowProps {
  session: StoredSession;
  live: boolean;
  canOpen: boolean;
  onOpen: () => void;
  onRename: () => void;
}

function SessionRow({ session, live, canOpen, onOpen, onRename }: SessionRowProps) {
  const t = useT();
  return (
    <div className="group flex items-center hover:bg-accent-soft">
      <button
        role="menuitem"
        onClick={onOpen}
        disabled={!canOpen && !live}
        title={canOpen || live ? sessionLabel(session) : t("ai.historyBusy")}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 pl-3 text-left text-fg disabled:opacity-50"
      >
        <MessageSquare size={13} className={`shrink-0 ${live ? "text-accent" : "text-muted"}`} />
        <span className={`truncate ${session.name === undefined ? "" : "font-medium"}`}>
          {sessionLabel(session)}
        </span>
        <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted">{formatWhen(session.updatedAt)}</span>
      </button>
      <button
        onClick={onRename}
        title={t("ai.renameSession")}
        aria-label={t("ai.renameSession")}
        className="mr-1.5 shrink-0 rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-panel hover:text-fg focus:opacity-100"
      >
        <Pencil size={12} />
      </button>
    </div>
  );
}

interface SessionNameEditorProps {
  initial: string;
  /** What the session is called without a name - also what clearing the box goes back to. */
  placeholder: string;
  /** The new name, or null when the edit was abandoned. */
  onDone: (name: string | null) => void;
}

function SessionNameEditor({ initial, placeholder, onDone }: SessionNameEditorProps) {
  const t = useT();
  const [value, setValue] = useState(initial);
  return (
    <div className="flex items-center gap-1 px-2 py-1">
      <input
        autoFocus
        value={value}
        placeholder={placeholder}
        aria-label={t("ai.renameSession")}
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value);
        }}
        onFocus={(e) => {
          e.currentTarget.select();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") onDone(value);
          if (e.key === "Escape") onDone(null);
        }}
        className="min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1 text-fg outline-none focus:border-accent"
      />
      <button
        onClick={() => {
          onDone(value);
        }}
        title={t("ai.renameSave")}
        aria-label={t("ai.renameSave")}
        className="rounded p-1 text-ok hover:bg-panel"
      >
        <Check size={13} />
      </button>
      <button
        onClick={() => {
          onDone(null);
        }}
        title={t("ai.renameCancel")}
        aria-label={t("ai.renameCancel")}
        className="rounded p-1 text-muted hover:bg-panel hover:text-fg"
      >
        <X size={13} />
      </button>
    </div>
  );
}
