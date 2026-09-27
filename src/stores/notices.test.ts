import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { failedTo, loggedAs, useNotices } = await import("./notices");

describe("notices", () => {
  beforeEach(() => {
    useNotices.setState({ notices: [] });
    invoke.mockClear();
  });

  it("says what a person asked for failed and why, and writes it to the error log", () => {
    failedTo("Could not open https://example.com")(new Error("no browser registered"));
    expect(useNotices.getState().notices).toMatchObject([
      { what: "Could not open https://example.com", reason: "no browser registered" },
    ]);
    expect(invoke).toHaveBeenCalledWith(
      "report_error",
      expect.objectContaining({ report: expect.objectContaining({ kind: "action-failed" }) as unknown }),
    );
  });

  it("keeps the newest few, so a burst of failures never covers the editor", () => {
    for (const n of [1, 2, 3, 4]) failedTo(`attempt ${String(n)}`)("refused");
    expect(useNotices.getState().notices.map((notice) => notice.what)).toEqual([
      "attempt 2",
      "attempt 3",
      "attempt 4",
    ]);
  });

  it("puts background failures in the log only, since nobody is waiting on them", () => {
    loggedAs("file-index")(new Error("walk failed"));
    expect(useNotices.getState().notices).toEqual([]);
    expect(invoke).toHaveBeenCalledWith(
      "report_error",
      expect.objectContaining({ report: expect.objectContaining({ kind: "file-index" }) as unknown }),
    );
  });
});
