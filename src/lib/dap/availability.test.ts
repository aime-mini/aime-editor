import { describe, expect, it } from "vitest";
import { installableDebugger, teachableLanguage, usable, type AdapterAvailability } from "./availability";

/** debugpy runs out of the user's own Python, so an install here is the fix. */
const DEBUGPY: AdapterAvailability = {
  adapterId: "debugpy",
  languageId: "python",
  configType: "python",
  available: false,
  downloadable: false,
  buildsFirst: false,
  installHint: "pip install debugpy",
  learned: false,
  verified: true,
  launchExtra: {},
  verifyWith: null,
  deviceField: null,
};

describe("installableDebugger", () => {
  it("hands over an adapter this machine lacks and Aime cannot fetch itself", () => {
    expect(installableDebugger(DEBUGPY)).toEqual({
      adapterId: "debugpy",
      installHint: "pip install debugpy",
    });
  });

  it("says nothing for a language Aime drives no adapter for", () => {
    // The regression this file exists for: `null` is the answer for Markdown,
    // JSON and CSS just as much as for C++, and a banner offering to set up a
    // debugger for a README is the opposite of helpful. Nor would an install
    // help - a language whose adapter is not in Aime's catalog cannot be
    // stepped through until Aime itself ships one.
    expect(installableDebugger(null)).toBeNull();
  });

  it("says nothing before the probe has answered", () => {
    expect(installableDebugger(undefined)).toBeNull();
  });

  it("says nothing for an adapter Aime downloads itself", () => {
    expect(installableDebugger({ ...DEBUGPY, adapterId: "js-debug", downloadable: true })).toBeNull();
  });

  it("says nothing once the adapter is here", () => {
    expect(installableDebugger({ ...DEBUGPY, available: true })).toBeNull();
  });
});

describe("usable", () => {
  const here = { ...DEBUGPY, available: true };

  it("lets a built-in run: it was driven before it was written down", () => {
    expect(usable(here)).toBe(true);
  });

  it("refuses a taught adapter Aime has never watched stop", () => {
    // Half a debugger is worse than none (ARCHITECTURE §5) - the rule now has
    // to hold at run time, because the entry was written by an agent.
    expect(usable({ ...here, learned: true, verified: false })).toBe(false);
  });

  it("lets a taught adapter run once it has been proven here", () => {
    expect(usable({ ...here, learned: true, verified: true })).toBe(true);
  });

  it("refuses anything that is not installed, taught or not", () => {
    expect(usable(DEBUGPY)).toBe(false);
  });
});

describe("teachableLanguage", () => {
  it("offers teaching for program languages Aime ships no adapter for", () => {
    // The php case that exposed the gap: completions worked (the server had
    // installed itself), no adapter existed, and no surface offered to teach
    // one — even though learned adapters had made that offer keepable.
    for (const language of ["php", "ruby", "lua", "kotlin", "elixir"]) {
      expect(teachableLanguage(language), language).toBe(true);
    }
  });

  it("stays quiet for documents, stylesheets and data", () => {
    // The session-6 rule survives: nothing can give a README a program to
    // step through, so these files must never carry the offer.
    for (const language of ["markdown", "plaintext", "css", "json", "yaml", "sql", "dockerfile"]) {
      expect(teachableLanguage(language), language).toBe(false);
    }
  });
});
