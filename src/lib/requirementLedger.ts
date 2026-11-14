import type { Brief, Criterion, SetAside } from "./aiRun";
import { asArray, asRecord, asString, objectIn } from "./replyJson";

/**
 * The ticket and the criteria read out of it, held against each other.
 *
 * Every later gate proves the code against the criteria, so a criterion that
 * misreads the ticket - or a requirement no criterion carries - is a change that
 * passes every gate and is still wrong. Two checks close that gap, in the order
 * the cost of each allows:
 *
 * - Mechanical, both ways, and free: every criterion quotes the ticket sentence
 *   it comes from, and the quote has to be in the ticket; every sentence of the
 *   ticket is cited by a criterion or set aside with a reason. A model that
 *   paraphrased its way to a requirement the ticket never made, or skipped a
 *   sentence, is caught here without a model call.
 * - Meaning, by a second reader: a turn with no tools and no repository, handed
 *   only the ticket and the criteria, looks for what was missed or misread. A
 *   criterion can cite the right sentence and still drop its limit or its
 *   error case, which no string comparison sees.
 *
 * What neither settles goes in front of the reader before the plan is agreed,
 * whatever the run's autonomy: the one mistake every later gate is blind to is
 * the one a person has to see.
 */

/** The ticket as the run read it. */
export interface Ticket {
  title: string;
  description: string;
}

/** Something between the ticket and the criteria that is not settled. */
export type LedgerGap =
  /** A criterion whose quote is not the ticket's: reworded, or invented. */
  | { kind: "unsourced"; id: string; quote: string }
  /** A ticket sentence no criterion cites and nobody set aside. */
  | { kind: "uncovered"; sentence: string }
  /** What the second reader found asked for and carried by no criterion. */
  | { kind: "missed"; quote: string; why: string }
  /** A criterion the second reader found asking for something its quote does not. */
  | { kind: "misread"; id: string; why: string }
  /** The second reading could not be had, which is not the same as it finding nothing. */
  | { kind: "unread"; detail: string };

/**
 * The text a criterion's quote is checked against and the sentences that need
 * one. A ticket with no description is its title: that is then the requirement.
 */
function requiredText(ticket: Ticket): string {
  return ticket.description.trim() === "" ? ticket.title : ticket.description;
}

/** A bullet or a number at the start of a line, which is layout rather than words. */
const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** The fewest words a line needs to be read as a sentence rather than a heading or a label. */
const SENTENCE_MIN_WORDS = 3;

/**
 * The ticket's sentences: the units a criterion cites and a reader sets aside.
 *
 * Lines first, because a ticket's bullets are its requirements one per line,
 * then sentence ends within a line. A heading ("Acceptance criteria:") or a
 * label of a word or two asks for nothing and is left out rather than made
 * into a sentence somebody has to set aside.
 */
export function sentencesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(LIST_MARKER, "").trim())
    .filter((line) => line !== "" && !line.endsWith(":"))
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.split(/\s+/).length >= SENTENCE_MIN_WORDS);
}

/**
 * Text as it is compared: one space for any run of white space, typographic
 * quotes as plain ones, no closing punctuation, one case. A quote that kept the
 * ticket's words but lost a full stop or a line break is still the ticket's.
 */
function normal(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?;:,]+$/, "")
    .toLowerCase();
}

/** The shortest quote that may stand for a sentence it is part of. Below this, "the" would cover everything. */
const QUOTE_MIN_CHARS = 15;

/** Whether a quote stands for this sentence: the whole of it, or a real part of it. */
function cites(quote: string, sentence: string): boolean {
  const said = normal(quote);
  const wanted = normal(sentence);
  if (said === "") return false;
  if (said.includes(wanted)) return true;
  return wanted.includes(said) && said.length >= Math.min(wanted.length, QUOTE_MIN_CHARS);
}

/** The gaps a string comparison can find, both ways round. */
export function mechanicalGaps(ticket: Ticket, brief: Pick<Brief, "criteria" | "setAside">): LedgerGap[] {
  const whole = normal(`${ticket.title}\n${ticket.description}`);
  const unsourced: LedgerGap[] = brief.criteria
    .filter((one) => one.quote.trim() === "" || !whole.includes(normal(one.quote)))
    .map((one) => ({ kind: "unsourced", id: one.id, quote: one.quote }));
  const quotes = [...brief.criteria.map((one) => one.quote), ...brief.setAside.map((one) => one.quote)];
  const uncovered: LedgerGap[] = sentencesOf(requiredText(ticket))
    .filter((sentence) => !quotes.some((quote) => cites(quote, sentence)))
    .map((sentence) => ({ kind: "uncovered", sentence }));
  return [...unsourced, ...uncovered];
}

/** How each sentence of the ticket was answered, for the page the reader agrees to. */
export interface SentenceCoverage {
  sentence: string;
  /** The criteria that cite it. */
  criteria: string[];
  /** Why it was set aside, when it was. */
  setAside: string | null;
}

export function coverageOf(ticket: Ticket, brief: Pick<Brief, "criteria" | "setAside">): SentenceCoverage[] {
  return sentencesOf(requiredText(ticket)).map((sentence) => ({
    sentence,
    criteria: brief.criteria.filter((one) => cites(one.quote, sentence)).map((one) => one.id),
    setAside: brief.setAside.find((one) => cites(one.quote, sentence))?.why ?? null,
  }));
}

/** A gap as one line of a prompt; the panel says it in the reader's language instead. */
export function describeGap(gap: LedgerGap): string {
  switch (gap.kind) {
    case "unsourced":
      return `${gap.id}: its quote is not in the ticket - "${gap.quote}". Quote the ticket's own words, character for character.`;
    case "uncovered":
      return `No criterion cites this sentence, and it was not set aside: "${gap.sentence}"`;
    case "missed":
      return `A second reader found this asked for and carried by no criterion: "${gap.quote}" - ${gap.why}`;
    case "misread":
      return `${gap.id} may not say what its quote says: ${gap.why}`;
    case "unread":
      return `The second reading could not be done: ${gap.detail}`;
  }
}

/** The ticket, laid out for a reader with nothing else in front of it. */
function ticketBlock(ticket: Ticket): string {
  return [`Title: ${ticket.title}`, "Description:", ticket.description.trim() || "(none)"].join("\n");
}

function criteriaBlock(brief: Pick<Brief, "criteria" | "setAside">): string {
  return [
    "Acceptance criteria:",
    ...brief.criteria.map((one) => `${one.id}: ${one.text}\n    quoting: "${one.quote}"`),
    ...(brief.setAside.length > 0 ? ["Set aside as not a requirement:"] : []),
    ...brief.setAside.map((one) => `- "${one.quote}" - ${one.why}`),
  ].join("\n");
}

const AUDIT_PROMPT = `Check another reader's understanding of a ticket. Below are the ticket exactly as written and the
acceptance criteria they drew from it, each with the ticket's words it quotes. Find what they missed
and what they got wrong - nothing else.

Answer ONLY with JSON, no prose and no code fence:
{"missed": [{"quote": "the ticket's words", "why": "what is asked that no criterion carries"}],
 "misread": [{"id": "AC2", "why": "what the ticket says, and how this criterion differs"}]}

- "missed": something the ticket asks for that no criterion carries - a limit, a number, a format, an
  error case, a permission, a state - even when the sentence it is in is quoted by a criterion that
  dropped it. Quote the ticket's words character for character.
- "misread": a criterion that asks for more, less or something other than the ticket says, or a
  requirement the ticket does not make at all. A criterion that only restates its quote in
  "WHEN ..., THE SYSTEM SHALL ..." form is not misread.
- A sentence set aside that does ask for something is "missed".
- When there is nothing to report, answer {"missed": [], "misread": []}. Do not invent a problem to
  have something to say.
`;

export function auditPrompt(ticket: Ticket, brief: Pick<Brief, "criteria" | "setAside">): string {
  return [AUDIT_PROMPT, ticketBlock(ticket), "", criteriaBlock(brief)].join("\n");
}

/** The second reader's findings as gaps, or null when the reply was not an answer. */
export function parseAudit(reply: string): LedgerGap[] | null {
  const object = objectIn(reply);
  if (!Array.isArray(object.missed) || !Array.isArray(object.misread)) return null;
  const missed = asArray(object.missed).flatMap((entry): LedgerGap[] => {
    const row = asRecord(entry);
    const quote = asString(row.quote);
    return quote === "" ? [] : [{ kind: "missed", quote, why: asString(row.why) }];
  });
  const misread = asArray(object.misread).flatMap((entry): LedgerGap[] => {
    const row = asRecord(entry);
    const id = asString(row.id);
    return id === "" ? [] : [{ kind: "misread", id, why: asString(row.why) }];
  });
  return [...missed, ...misread];
}

const REVISE_PROMPT = `The acceptance criteria you drew from this ticket left the gaps listed at the end. Close them, and
answer the complete list again - every criterion, and every sentence set aside - not only the changes.

Answer ONLY with JSON, no prose and no code fence:
{"criteria": [{"id": "AC1", "text": "WHEN ..., THE SYSTEM SHALL ...", "quote": "the ticket's own words"}],
 "notRequirements": [{"quote": "the ticket's own words", "why": "why it asks for nothing"}]}

- "quote" is copied from the ticket character for character: the sentence, or the part of it this
  criterion comes from. Never reworded - it is checked against the ticket.
- Every sentence of the ticket that asks for something is quoted by at least one criterion. A sentence
  that asks for nothing - background, a link, a greeting - goes in "notRequirements" with why.
- Keep the ids of criteria that stay; a new criterion takes the next free id.
`;

export function revisePrompt(
  ticket: Ticket,
  brief: Pick<Brief, "criteria" | "setAside">,
  gaps: readonly LedgerGap[],
): string {
  return [
    REVISE_PROMPT,
    ticketBlock(ticket),
    "",
    "Your criteria:",
    criteriaBlock(brief),
    "",
    "The gaps:",
    ...gaps.map((gap) => `- ${describeGap(gap)}`),
  ].join("\n");
}

/** The revised criteria, or null when the reply held none. */
export function parseRevision(reply: string): Pick<Brief, "criteria" | "setAside"> | null {
  const object = objectIn(reply);
  const criteria = criteriaIn(object.criteria);
  if (criteria.length === 0) return null;
  return { criteria, setAside: setAsideIn(object.notRequirements) };
}

/** Criteria out of a reply's list; an unnumbered one still needs a handle, or no test can cite it. */
export function criteriaIn(value: unknown): Criterion[] {
  return asArray(value)
    .map((entry, index) => {
      const row = asRecord(entry);
      return {
        id: asString(row.id) || `AC${String(index + 1)}`,
        text: asString(row.text),
        quote: asString(row.quote),
      };
    })
    .filter((criterion) => criterion.text !== "");
}

/** Sentences a reply set aside, each with the reason it asks for nothing. */
export function setAsideIn(value: unknown): SetAside[] {
  return asArray(value)
    .map((entry) => {
      const row = asRecord(entry);
      return { quote: asString(row.quote), why: asString(row.why) };
    })
    .filter((one) => one.quote !== "");
}
