import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CornerDownLeft, ExternalLink, GitBranch, Loader2, Sparkles } from "lucide-react";
import { useI18n, useT } from "../i18n";
import { branchNameFor, readableId, whenText } from "../lib/workItems";
import { Markdown } from "./Markdown";
import { useGit } from "../stores/git";
import {
  useTrackers,
  type Comment,
  type Fact,
  type StateOption,
  type WorkItem,
  type WorkItemDetail,
} from "../stores/trackers";
import { PromptModal } from "./PromptModal";
import { Waiting } from "./Waiting";

/**
 * A read that is still out, or one that has answered - with `null` for an answer
 * that could not be had. Three states, because "nothing yet" and "nothing there"
 * must not look alike.
 */
type Read<T> = { reading: true } | { reading: false; value: T | null };

const READING = { reading: true } as const;

/**
 * One work item, in the middle of the window.
 *
 * It lives here rather than in the sidebar because that is where the room is: a
 * description worth reading, a conversation worth following and a set of facts
 * worth scanning do not fit in a column the width of a file tree. The sidebar
 * keeps the list; this keeps the item.
 */
export function WorkItemView({ itemId }: { itemId: string }) {
  const t = useT();
  const item = useTrackers((state) => state.items.find((candidate) => candidate.id === itemId) ?? null);
  const [detail, setDetail] = useState<Read<WorkItemDetail>>(READING);
  const [comments, setComments] = useState<Read<Comment[]>>(READING);

  /** Reads the conversation on its own - what a posted comment needs. */
  const readComments = useCallback((target: WorkItem) => {
    void useTrackers
      .getState()
      .commentsOf(target)
      .then((value) => {
        setComments({ reading: false, value });
      });
  }, []);

  // The view is keyed by the item id (see EditorPane), so opening another item
  // is a fresh mount. This runs again when the list itself is refreshed and the
  // item object is replaced, which is what keeps the facts and the conversation
  // as current as the row above them. The two reads are separate on purpose:
  // they have nothing to say to each other, so the text appears as soon as it
  // arrives instead of waiting behind a slow conversation. Nothing is set before
  // an answer arrives, and a late answer to a view that has moved on is dropped.
  useEffect(() => {
    if (item === null) return undefined;
    let alive = true;
    void useTrackers
      .getState()
      .detailOf(item)
      .then((value) => {
        if (alive) setDetail({ reading: false, value });
      });
    void useTrackers
      .getState()
      .commentsOf(item)
      .then((value) => {
        if (alive) setComments({ reading: false, value });
      });
    return () => {
      alive = false;
    };
  }, [item]);

  if (item === null) {
    // The list moved on (a refresh, another board): there is nothing to show and
    // saying so beats an empty frame.
    return <p className="p-4 text-[12px] text-muted">{t("tracker.itemGone")}</p>;
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-bg">
      <Header item={item} />
      <div className="mx-auto w-full max-w-3xl px-6 pb-10">
        {!detail.reading && detail.value !== null && detail.value.facts.length > 0 && (
          <Facts facts={detail.value.facts} />
        )}

        <Section title={t("tracker.description")}>
          {detail.reading ? (
            <Waiting label={t("tracker.loadingDetail")} />
          ) : detail.value === null || detail.value.description === "" ? (
            <p className="text-[12.5px] text-muted">
              {t(detail.value === null ? "tracker.detailUnavailable" : "tracker.noDescriptionShort")}
            </p>
          ) : (
            // Every connector hands its description over as Markdown, which is
            // what keeps the steps a list and the headings headings.
            <Markdown text={detail.value.description} />
          )}
        </Section>

        <Section title={t("tracker.comments")}>
          {comments.reading ? (
            <Waiting label={t("tracker.loadingComments")} />
          ) : (
            <Conversation
              item={item}
              comments={comments.value}
              onPosted={() => {
                readComments(item);
              }}
            />
          )}
        </Section>
      </div>
    </div>
  );
}

/** Who this item is, and the three things worth doing to it. */
function Header({ item }: { item: WorkItem }) {
  const t = useT();
  const isRepo = useGit((state) => state.status?.is_repo ?? false);
  const [branching, setBranching] = useState(false);

  return (
    <div className="sticky top-0 z-10 border-b border-line bg-panel/95 backdrop-blur">
      <div className="mx-auto w-full max-w-3xl px-6 py-4">
        {item.parent !== null && (
          <p className="mb-1 truncate text-[11.5px] text-muted" title={item.parent.title}>
            {t("tracker.under", { name: item.parent.title })}
          </p>
        )}
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0 text-[12px] text-muted">#{readableId(item)}</span>
          <h1 className="min-w-0 flex-1 text-[15px] font-medium leading-snug">{item.title}</h1>
        </div>
        {/* Two groups rather than one wrapping row: the actions are always in the
            same corner, and it is the chips that give way when the window is
            narrow. A single row wrapped the last action onto a line of its own. */}
        <div className="mt-2 flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <StatePicker item={item} />
            <Chip>{item.itemType}</Chip>
            {item.dimensions.map((dimension) => (
              <Chip key={dimension.label}>{labelled(dimension)}</Chip>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Action
              icon={<ExternalLink size={12} />}
              label={t("tracker.openInBrowser")}
              onClick={() => {
                openUrl(item.webUrl).catch(console.error);
              }}
            />
            <Action
              icon={<GitBranch size={12} />}
              label={t("tracker.branchAction")}
              disabled={!isRepo}
              onClick={() => {
                setBranching(true);
              }}
            />
            <Action
              icon={<Sparkles size={12} />}
              label={t("tracker.askAi")}
              onClick={() => void useTrackers.getState().askAi(item)}
            />
          </div>
        </div>
      </div>

      {branching && (
        <PromptModal
          title={t("tracker.branchTitle", { id: readableId(item) })}
          hint={t("tracker.branchHint")}
          initialValue={branchNameFor(item)}
          onSubmit={(name) => {
            setBranching(false);
            void useTrackers.getState().startBranch(name);
          }}
          onClose={() => {
            setBranching(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * The state, and where it can go from here. The list comes from the service when
 * the menu opens, which is the only way to know it (every board names its own).
 */
function StatePicker({ item }: { item: WorkItem }) {
  const t = useT();
  const [states, setStates] = useState<StateOption[] | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    if (states !== null) {
      setStates(null);
      return;
    }
    setBusy(true);
    const offered = await useTrackers.getState().statesFor(item);
    setStates(offered.length > 0 ? offered : null);
    setBusy(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => void open()}
        title={t("tracker.changeState")}
        className="rounded border border-line px-2 py-0.5 text-[11.5px] hover:border-accent hover:text-accent"
      >
        {busy ? "…" : item.state}
      </button>
      {states !== null && (
        <div className="absolute left-0 top-full z-20 mt-1 max-h-64 w-56 overflow-y-auto rounded-md border border-line bg-panel p-1 shadow-xl">
          {states.map((option) => (
            <button
              key={option.name}
              onClick={() => {
                setStates(null);
                void useTrackers.getState().moveTo(item, option.name);
              }}
              disabled={option.name === item.state}
              className="block w-full truncate rounded px-2 py-1 text-left text-[12px] hover:bg-elevated disabled:font-medium disabled:text-accent"
            >
              {option.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One dimension as a chip reads it: "Board: Accounts", but "Sprint 24" rather
 * than "Sprint: Sprint 24" - a value that already says what it is does not need
 * to be told twice.
 */
function labelled(dimension: Fact): string {
  const value = dimension.value.trim();
  return value.toLowerCase().startsWith(dimension.label.toLowerCase())
    ? value
    : `${dimension.label}: ${value}`;
}

/** The short facts, as the service labels them - two columns, no invention. */
function Facts({ facts }: { facts: Fact[] }) {
  return (
    <dl className="mt-5 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12px]">
      {facts.map((fact) => (
        <div key={fact.label} className="col-span-2 grid grid-cols-subgrid">
          <dt className="text-muted">{fact.label}</dt>
          {/* Wrapped, not cut: these are short by nature, and a fact whose end is
              missing is a fact the reader has to go to the browser for. */}
          <dd className="min-w-0 break-words">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The conversation, and a box to add to it. */
function Conversation({
  item,
  comments,
  onPosted,
}: {
  item: WorkItem;
  comments: Comment[] | null;
  onPosted: () => void;
}) {
  const t = useT();
  const locale = useI18n((state) => state.locale);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const send = () => {
    if (draft.trim() === "" || sending) return;
    setSending(true);
    void useTrackers
      .getState()
      .comment(item, draft)
      .then((posted) => {
        setSending(false);
        if (!posted) return;
        // Cleared only once the service has it: a comment that vanished from the
        // box without arriving anywhere is the worst outcome here.
        setDraft("");
        onPosted();
      });
  };

  return (
    <>
      {comments === null ? (
        <p className="text-[12px] text-muted">{t("tracker.commentsUnavailable")}</p>
      ) : comments.length === 0 ? (
        <p className="text-[12px] text-muted">{t("tracker.noComments")}</p>
      ) : (
        <ul className="space-y-3">
          {comments.map((comment, index) => (
            <li key={`${comment.when}-${String(index)}`} className="rounded-md border border-line p-2.5">
              <p className="flex items-baseline gap-2 text-[11px] text-muted">
                <span className="truncate font-medium text-fg/80">{comment.author}</span>
                {/* Every service stamps this differently; none of their formats is
                    something to read. */}
                <span className="truncate" title={comment.when}>
                  {whenText(comment.when, locale)}
                </span>
              </p>
              <div className="mt-1.5">
                <Markdown text={comment.text} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3">
        <textarea
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter is a new line: this is a message box, and
            // that is what a message box does.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          rows={3}
          placeholder={t("tracker.commentPlaceholder")}
          className="w-full resize-y rounded-md border border-line bg-elevated px-2.5 py-2 text-[12.5px] outline-none focus:border-accent"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <button
            onClick={send}
            disabled={draft.trim() === "" || sending}
            className="flex items-center gap-1.5 rounded bg-accent-strong px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? <Loader2 size={12} className="animate-spin" /> : <CornerDownLeft size={12} />}
            {t("tracker.comment")}
          </button>
          <span className="text-[11px] text-muted">{t("tracker.commentHint")}</span>
        </div>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-[11px] uppercase tracking-wide text-muted">{title}</h2>
      {children}
    </section>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="max-w-[14rem] truncate rounded border border-line px-1.5 py-0.5 text-[11px] text-muted">
      {children}
    </span>
  );
}

function Action({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 rounded border border-line px-2 py-0.5 text-[11.5px] text-muted hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-muted"
    >
      {icon} {label}
    </button>
  );
}
