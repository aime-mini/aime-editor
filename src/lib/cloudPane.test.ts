import { describe, expect, it } from "vitest";
import { paneStateOf } from "./cloudPane";

describe("what a cloud's pane is showing", () => {
  it("is looking while the CLIs have not answered", () => {
    expect(paneStateOf(true, undefined, true)).toBe("looking");
    // Not probing any more, but this cloud has still not been asked.
    expect(paneStateOf(true, undefined, false)).toBe("looking");
  });

  it("offers the CLI only once the probe that would have found it is done", () => {
    // The bug this rules out: a cloud whose CLI was missing a moment ago
    // offering an install while the probe is still running.
    expect(paneStateOf(false, [], true)).toBe("looking");
    expect(paneStateOf(false, [], false)).toBe("cli-missing");
  });

  it("asks for a sign-in when the CLI is here and holds nobody", () => {
    expect(paneStateOf(true, [], false)).toBe("signed-out");
  });

  it("shows the accounts whenever there are any, whatever else is going on", () => {
    expect(paneStateOf(true, [{ id: "p1" }], false)).toBe("accounts");
    // An account in hand outranks a probe still running: what is on screen is
    // real, and blanking it to a spinner would be a step backwards.
    expect(paneStateOf(true, [{ id: "p1" }], true)).toBe("accounts");
    // And a CLI Aime fetched itself is not "installed" by the probe's reckoning
    // in every case, yet its accounts are accounts.
    expect(paneStateOf(false, [{ id: "ref" }], false)).toBe("accounts");
  });
});
