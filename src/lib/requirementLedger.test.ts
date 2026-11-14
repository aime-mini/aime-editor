import { describe, expect, it } from "vitest";
import {
  coverageOf,
  mechanicalGaps,
  parseAudit,
  parseRevision,
  sentencesOf,
  type Ticket,
} from "./requirementLedger";

const TICKET: Ticket = {
  title: "Cap the discount code",
  description: [
    "Customers abuse long discount codes.",
    "Acceptance criteria:",
    "- A code longer than 20 characters is rejected with the message “Code too long”.",
    "- Valid codes keep working at checkout.",
    "See the thread in the support channel.",
  ].join("\n"),
};

const quoting = (id: string, quote: string) => ({ id, text: `THE SYSTEM SHALL ${quote}`, quote });

describe("sentencesOf", () => {
  it("reads a bullet per line and leaves headings out", () => {
    expect(sentencesOf(TICKET.description)).toEqual([
      "Customers abuse long discount codes.",
      "A code longer than 20 characters is rejected with the message “Code too long”.",
      "Valid codes keep working at checkout.",
      "See the thread in the support channel.",
    ]);
  });

  it("splits a paragraph at its sentence ends", () => {
    expect(sentencesOf("The total is rounded. It shows two decimals!")).toEqual([
      "The total is rounded.",
      "It shows two decimals!",
    ]);
  });
});

describe("mechanicalGaps", () => {
  const covered = {
    criteria: [
      quoting("AC1", 'A code longer than 20 characters is rejected with the message "Code too long"'),
      quoting("AC2", "Valid codes keep working at checkout"),
    ],
    setAside: [
      { quote: "Customers abuse long discount codes.", why: "background" },
      { quote: "See the thread in the support channel.", why: "a pointer, not a requirement" },
    ],
  };

  it("finds nothing when every sentence is carried or set aside and every quote is the ticket's", () => {
    // Typographic quotes in the ticket and plain ones in the quote are the same words.
    expect(mechanicalGaps(TICKET, covered)).toEqual([]);
  });

  it("finds a sentence nobody carried", () => {
    const skipped = { ...covered, criteria: covered.criteria.slice(0, 1) };
    expect(mechanicalGaps(TICKET, skipped)).toEqual([
      { kind: "uncovered", sentence: "Valid codes keep working at checkout." },
    ]);
  });

  it("finds a quote the ticket never said, which is a requirement invented on its way to a criterion", () => {
    const reworded = {
      ...covered,
      criteria: [...covered.criteria, quoting("AC3", "codes are case-insensitive")],
    };
    expect(mechanicalGaps(TICKET, reworded)).toEqual([
      { kind: "unsourced", id: "AC3", quote: "codes are case-insensitive" },
    ]);
  });

  it("does not let a scrap of a sentence stand for the whole of it", () => {
    const scrap = {
      ...covered,
      criteria: [covered.criteria[0], quoting("AC2", "Valid codes")],
    };
    expect(mechanicalGaps(TICKET, scrap)).toContainEqual({
      kind: "uncovered",
      sentence: "Valid codes keep working at checkout.",
    });
  });

  it("takes the title as the requirement of a ticket with no description", () => {
    const bare: Ticket = { title: "Show the currency code on totals", description: "" };
    expect(mechanicalGaps(bare, { criteria: [], setAside: [] })).toEqual([
      { kind: "uncovered", sentence: "Show the currency code on totals" },
    ]);
    expect(
      mechanicalGaps(bare, { criteria: [quoting("AC1", "Show the currency code on totals")], setAside: [] }),
    ).toEqual([]);
  });
});

describe("coverageOf", () => {
  it("says which criteria carry each sentence, and why a sentence was set aside", () => {
    const lines = coverageOf(TICKET, {
      criteria: [quoting("AC2", "Valid codes keep working at checkout")],
      setAside: [{ quote: "Customers abuse long discount codes.", why: "background" }],
    });
    expect(lines[0]).toEqual({
      sentence: "Customers abuse long discount codes.",
      criteria: [],
      setAside: "background",
    });
    expect(lines[2]).toEqual({
      sentence: "Valid codes keep working at checkout.",
      criteria: ["AC2"],
      setAside: null,
    });
    expect(lines[1].criteria).toEqual([]);
    expect(lines[1].setAside).toBeNull();
  });
});

describe("parseAudit", () => {
  it("reads what the second reader found missed and misread", () => {
    const reply =
      '{"missed": [{"quote": "longer than 20 characters", "why": "the limit is not in AC1"}],' +
      ' "misread": [{"id": "AC2", "why": "the ticket says checkout, the criterion says cart"}]}';
    expect(parseAudit(reply)).toEqual([
      { kind: "missed", quote: "longer than 20 characters", why: "the limit is not in AC1" },
      { kind: "misread", id: "AC2", why: "the ticket says checkout, the criterion says cart" },
    ]);
  });

  it("reads an empty answer as nothing found, and no answer as no reading at all", () => {
    expect(parseAudit('{"missed": [], "misread": []}')).toEqual([]);
    expect(parseAudit("Looks fine to me.")).toBeNull();
  });
});

describe("parseRevision", () => {
  it("reads the whole revised list, criteria and set-aside sentences", () => {
    const reply =
      '{"criteria": [{"id": "AC1", "text": "THE SYSTEM SHALL keep valid codes working", "quote": "Valid codes keep working"}],' +
      ' "notRequirements": [{"quote": "See the thread", "why": "a pointer"}]}';
    expect(parseRevision(reply)).toEqual({
      criteria: [
        { id: "AC1", text: "THE SYSTEM SHALL keep valid codes working", quote: "Valid codes keep working" },
      ],
      setAside: [{ quote: "See the thread", why: "a pointer" }],
    });
  });

  it("has no revision when the reply holds no criterion", () => {
    expect(parseRevision('{"criteria": []}')).toBeNull();
  });
});
