import type { ChatMessage, MessagePart, ToolStatus, ToolStep, TurnActivity, UiAiEvent } from "./types";

/**
 * How the turn being written changes as its events arrive: the parts of its
 * message, and the one line that says what is happening right now. Pure, so
 * the store only applies it and the tests need no store.
 */

/** The name Claude Code gives the tool that starts a subagent. */
const SUBAGENT_TOOL = "Agent";

type ToolCall = Extract<UiAiEvent, { kind: "tool-call" }>;
type ToolPart = Extract<MessagePart, { kind: "tool" }>;

export function appendText(message: ChatMessage, text: string): ChatMessage {
  const lastPart = message.parts.at(-1);
  const parts =
    lastPart?.kind === "text"
      ? [...message.parts.slice(0, -1), { kind: "text" as const, text: lastPart.text + text }]
      : [...message.parts, { kind: "text" as const, text }];
  return { ...message, parts };
}

/** A call whose input is still being written gets its chip now, not when the input is complete. */
export function withToolStarted(message: ChatMessage, id: string, name: string): ChatMessage {
  return {
    ...message,
    parts: [...message.parts, { kind: "tool", name, detail: "", id, status: "preparing" }],
  };
}

/**
 * A complete tool call: it fills in the chip its start made, or - from a CLI
 * that announces calls only once they are whole - adds one. A subagent's call
 * is filed under the Agent call that started it instead.
 *
 * @param label what the subagent was sent to do, for a call this message does not hold.
 */
export function withToolCall(message: ChatMessage, call: ToolCall, label: string): ChatMessage {
  const { name, detail, id, parentId } = call;
  if (parentId !== undefined) return appendStep(message, parentId, { name, detail }, label);
  const started = id === undefined ? -1 : message.parts.findIndex((part) => isCall(part, id));
  if (started === -1) {
    return { ...message, parts: [...message.parts, { kind: "tool", name, detail, id, status: "running" }] };
  }
  return patchCall(message, started, (part) => ({ ...part, name, detail, status: "running" }));
}

/** What a call whose input is still streaming is about, as soon as that input says - once. */
export function withToolSubject(message: ChatMessage, id: string, detail: string): ChatMessage {
  const index = message.parts.findIndex((part) => isCall(part, id) && part.detail === "");
  return index === -1 ? message : patchCall(message, index, (part) => ({ ...part, detail }));
}

/** A call came back; a call this message does not hold is left alone. */
export function withToolResult(message: ChatMessage, id: string, failed: boolean): ChatMessage {
  const index = message.parts.findIndex((part) => isCall(part, id));
  if (index === -1) return message;
  const status: ToolStatus = failed ? "failed" : "done";
  return patchCall(message, index, (part) => ({ ...part, status }));
}

/**
 * Files a subagent's tool call under the Agent call that started it. A
 * subagent resumed by a later turn answers to a call this message does not
 * hold, so that call gets a chip of its own, named after its background task
 * when the CLI has listed one.
 */
function appendStep(message: ChatMessage, parentId: string, step: ToolStep, label: string): ChatMessage {
  const index = message.parts.findIndex((part) => isCall(part, parentId));
  if (index === -1) {
    return {
      ...message,
      parts: [
        ...message.parts,
        { kind: "tool", name: SUBAGENT_TOOL, detail: label, id: parentId, steps: [step] },
      ],
    };
  }
  return patchCall(message, index, (part) => ({ ...part, steps: [...(part.steps ?? []), step] }));
}

function isCall(part: MessagePart, id: string): part is ToolPart {
  return part.kind === "tool" && part.id === id;
}

function patchCall(message: ChatMessage, index: number, patch: (part: ToolPart) => ToolPart): ChatMessage {
  const parts = message.parts.map((part, i) => (i === index && part.kind === "tool" ? patch(part) : part));
  return { ...message, parts };
}

/** What the queue needs of a message to follow it from written to read. */
interface Queueable {
  id: string;
  text: string;
  /** What the CLI was handed, or null while the message still waits in Aime. */
  sent: string | null;
}

/**
 * Which handed message the AI has read: the one the CLI names, else the one
 * whose text came back. The id decides whenever there is one, because the
 * text does not survive every read - messages that waited together come back
 * under their own ids with their texts joined.
 */
function readMessage<Q extends Queueable>(queued: Q[], read: { id?: string; text?: string }): Q | undefined {
  const handed = queued.filter((item) => item.sent !== null);
  const byId = read.id === undefined ? undefined : handed.find((item) => item.id === read.id);
  return byId ?? (read.text === undefined ? undefined : handed.find((item) => item.sent === read.text));
}

/**
 * A message handed to the running turn was read by the AI: it takes its
 * place in the conversation, the answer so far closes, and what follows is a
 * new answer under it. The turn's own prompt is echoed the same way and
 * matches nothing queued: it is in the conversation already.
 */
export function withQueuedRead<Q extends Queueable>(
  messages: ChatMessage[],
  queued: Q[],
  echoed: { id?: string; text?: string },
): { messages: ChatMessage[]; queued: Q[] } | null {
  const read = readMessage(queued, echoed);
  if (read === undefined) return null;
  const closed = messages.map((message, index) => {
    if (index !== messages.length - 1 || message.role !== "assistant") return message;
    const ended = { ...message };
    delete ended.unfinished;
    return ended;
  });
  return {
    queued: queued.filter((item) => item !== read),
    messages: [
      ...closed,
      { role: "user", parts: [{ kind: "text", text: read.text }] },
      { role: "assistant", parts: [], unfinished: true },
    ],
  };
}

/**
 * The queued message to hand the turn next: the oldest still waiting, once
 * the AI has read every message handed before it. Handing them over one at a
 * time keeps each a message of its own - several waiting in the CLI at once
 * are read as one, and the AI answers only the first of them (measured on
 * 2.1.316) - and keeps them in the order they were written.
 */
export function nextToHandOver<Q extends Queueable>(queued: Q[]): Q | undefined {
  if (queued.some((item) => item.sent !== null)) return undefined;
  return queued.at(0);
}

/**
 * What the turn is doing once `event` has happened. The clock of a state that
 * merely continues - text still arriving, one more chunk of a file - keeps
 * running; a new state starts its own.
 */
export function activityAfter(current: TurnActivity, event: UiAiEvent, now: number): TurnActivity {
  switch (event.kind) {
    case "phase":
      return continued(current, event.phase === "thinking" ? "thinking" : "waiting", now);
    case "message-delta":
      return continued(current, "writing", now);
    case "tool-start":
      return {
        kind: "tool",
        since: now,
        id: event.id,
        name: event.name,
        detail: "",
        preparing: true,
        inputChars: 0,
      };
    case "tool-input":
      return isActivityOf(current, event.id)
        ? { ...current, inputChars: event.chars, detail: event.detail ?? current.detail }
        : current;
    case "tool-call":
      // A subagent's steps show under its own chip; the line keeps saying the Agent runs.
      if (event.parentId !== undefined) return current;
      return {
        kind: "tool",
        since: now,
        id: event.id,
        name: event.name,
        detail: event.detail,
        preparing: false,
        inputChars: 0,
      };
    case "tool-result":
      return isActivityOf(current, event.id) ? { kind: "waiting", since: now } : current;
    default:
      return current;
  }
}

function continued(
  current: TurnActivity,
  kind: "waiting" | "thinking" | "writing",
  now: number,
): TurnActivity {
  return current.kind === kind ? current : { kind, since: now };
}

function isActivityOf(
  activity: TurnActivity,
  id: string,
): activity is Extract<TurnActivity, { kind: "tool" }> {
  return activity.kind === "tool" && activity.id === id;
}
