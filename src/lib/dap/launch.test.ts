import { describe, expect, it } from "vitest";
import {
  applyBreakpointAnswer,
  applyBreakpointEvent,
  displayLine,
  launchConfig,
  newBreakpoint,
} from "./launch";

describe("launchConfig", () => {
  it("keeps the program's output inside the editor", () => {
    // Any other console setting hands the program to a terminal Aime does not
    // own, and the Debug Console would stay empty for the whole run.
    for (const type of ["pwa-node", "python"]) {
      expect(launchConfig(type, "C:/p/app.js", "C:/p").console).toBe("internalConsole");
    }
  });

  it("runs the file in the project folder, not in Aime's", () => {
    const config = launchConfig("pwa-node", "C:/p/app.js", "C:/p");
    expect(config).toMatchObject({ program: "C:/p/app.js", cwd: "C:/p", request: "launch" });
  });

  it("keeps node's own frames out of the user's call stack", () => {
    expect(launchConfig("pwa-node", "a.js", ".").skipFiles).toEqual(["<node_internals>/**"]);
    // The Python adapter has no such notion, and sending it would be noise.
    expect(launchConfig("python", "a.py", ".").skipFiles).toBeUndefined();
  });

  it("carries the adapter's own type through, so the catalog stays the one table", () => {
    expect(launchConfig("pwa-node", "a.js", ".").type).toBe("pwa-node");
    expect(launchConfig("python", "a.py", ".").type).toBe("python");
  });
});

describe("applyBreakpointAnswer", () => {
  it("draws the marker where the adapter put it, not where the user clicked", () => {
    // Measured against debugpy 1.8.21: line 4 (a blank line) comes back as 3.
    const [moved] = applyBreakpointAnswer([newBreakpoint(4)], [{ id: 1, verified: true, line: 3 }]);
    expect(moved).toEqual({ line: 4, actualLine: 3, verified: true, id: 1 });
    expect(displayLine(moved)).toBe(3);
  });

  it("matches by position, not by id", () => {
    // The two adapters number differently (debugpy from 0, js-debug from 1) and
    // neither promises id order, so only the array position is meaningful here.
    const requested = [newBreakpoint(4), newBreakpoint(9)];
    const fromZero = [
      { id: 0, verified: true, line: 3 },
      { id: 1, verified: false, line: 9 },
    ];
    expect(applyBreakpointAnswer(requested, fromZero)).toEqual([
      { line: 4, actualLine: 3, verified: true, id: 0 },
      { line: 9, actualLine: 9, verified: false, id: 1 },
    ]);
  });

  it("leaves a breakpoint the adapter skipped unverified instead of shifting the rest", () => {
    const requested = [newBreakpoint(4), newBreakpoint(9)];
    expect(applyBreakpointAnswer(requested, [{ verified: true, line: 3 }])).toEqual([
      { line: 4, actualLine: 3, verified: true, id: null },
      { line: 9, actualLine: null, verified: false, id: null },
    ]);
  });

  it("treats an answer with no line as agreeing with the request", () => {
    expect(applyBreakpointAnswer([newBreakpoint(7)], [{ verified: true }])).toEqual([
      { line: 7, actualLine: 7, verified: true, id: null },
    ]);
  });

  it("re-asks from the requested line, so a rejected breakpoint does not drift", () => {
    // First answer moves it, a later one rejects it: the user's line survives
    // both, which is what makes the next `setBreakpoints` ask the same question.
    const once = applyBreakpointAnswer([newBreakpoint(5)], [{ verified: true, line: 3 }]);
    const twice = applyBreakpointAnswer(once, []);
    expect(twice[0]).toEqual({ line: 5, actualLine: null, verified: false, id: null });
  });
});

describe("applyBreakpointEvent", () => {
  /** Verbatim from js-debug 1.117.0: this is all a provisional answer says. */
  const provisional = [
    { id: 1, verified: false, message: "breakpoint.provisionalBreakpoint" },
    { id: 2, verified: false, message: "breakpoint.provisionalBreakpoint" },
  ];

  it("resolves the provisional answer js-debug gives, out of order and by id", () => {
    // Requested lines 2 and 4; line 4 is a closing brace, and the adapter's
    // events - which arrive id 2 first - move it to 3 and verify both.
    let breakpoints = applyBreakpointAnswer([newBreakpoint(2), newBreakpoint(4)], provisional);
    expect(breakpoints.map(displayLine)).toEqual([2, 4]);
    expect(breakpoints.some((breakpoint) => breakpoint.verified)).toBe(false);

    breakpoints = applyBreakpointEvent(breakpoints, { id: 2, verified: true, line: 3 });
    breakpoints = applyBreakpointEvent(breakpoints, { id: 1, verified: true, line: 2 });
    expect(breakpoints.map(displayLine)).toEqual([2, 3]);
    expect(breakpoints.every((breakpoint) => breakpoint.verified)).toBe(true);
  });

  it("keeps the line when the event only changes the verified flag", () => {
    const breakpoints = applyBreakpointAnswer([newBreakpoint(9)], [{ id: 7, verified: true, line: 8 }]);
    expect(applyBreakpointEvent(breakpoints, { id: 7, verified: false })[0]).toEqual({
      line: 9,
      actualLine: 8,
      verified: false,
      id: 7,
    });
  });

  it("returns the same list for an event about a breakpoint it does not have", () => {
    const breakpoints = applyBreakpointAnswer([newBreakpoint(2)], [{ id: 1, verified: true }]);
    expect(applyBreakpointEvent(breakpoints, { id: 99, verified: true, line: 5 })).toBe(breakpoints);
    // An event with no id at all identifies nothing and must not match id: null.
    expect(applyBreakpointEvent(breakpoints, { verified: true })).toBe(breakpoints);
  });
});
