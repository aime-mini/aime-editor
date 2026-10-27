import { create } from "zustand";
import { reportError } from "../lib/diagnostics";

/**
 * Things that went wrong after a person asked for something, said where they
 * will see it.
 *
 * A link that would not open or a folder the file manager refused used to go
 * to the console - which in a desktop window nobody has open, so the click
 * simply seemed not to happen. A notice says what was being done and what the
 * system answered, and stays until it is dismissed or has been read.
 */
export interface Notice {
  id: number;
  /** A failure, in red - or news the person did not ask for but should know. */
  kind: "failed" | "told";
  what: string;
  reason: string;
}

/** Long enough to read a sentence and its reason; the X is always there sooner. */
const NOTICE_LIFETIME_MS = 12_000;

/** Enough to see that several things failed, few enough not to cover the editor. */
const MOST_SHOWN = 3;

interface NoticesState {
  notices: Notice[];
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useNotices = create<NoticesState>((set) => ({
  notices: [],
  dismiss: (id) => {
    set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) }));
  },
}));

/** What went wrong, in the words the backend or the OS used. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A `.catch` for something a person asked for: shows `what` failed and why,
 * and writes it to the error log (`lib/diagnostics.ts`) as well.
 */
export function failedTo(what: string): (error: unknown) => void {
  return (error) => {
    show({ id: nextId++, kind: "failed", what, reason: reasonOf(error) });
    reportError("action-failed", error, what);
  };
}

/**
 * News the person did not ask for but should know - a project that just
 * opened took its chat and memory from a transfer pack, say. Same corner,
 * same lifetime, not red.
 */
export function told(what: string, detail: string): void {
  show({ id: nextId++, kind: "told", what, reason: detail });
}

function show(notice: Notice): void {
  useNotices.setState((state) => ({ notices: [...state.notices, notice].slice(-MOST_SHOWN) }));
  setTimeout(() => {
    useNotices.getState().dismiss(notice.id);
  }, NOTICE_LIFETIME_MS);
}

/**
 * A `.catch` for work nobody is waiting on - an index built in the background,
 * a warm-up: there is no one to tell at that moment, so it goes to the error
 * log, which Settings opens.
 */
export function loggedAs(kind: string): (error: unknown) => void {
  return (error) => {
    reportError(kind, error);
  };
}
