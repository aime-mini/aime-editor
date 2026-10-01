import { describe, expect, it } from "vitest";
import { formatElapsed } from "./useSecondsSince";

describe("formatElapsed", () => {
  it("counts seconds up to a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59)).toBe("59s");
  });

  it("switches to minutes with two-digit seconds after that", () => {
    expect(formatElapsed(60)).toBe("1m 00s");
    expect(formatElapsed(125)).toBe("2m 05s");
    expect(formatElapsed(3725)).toBe("62m 05s");
  });
});
