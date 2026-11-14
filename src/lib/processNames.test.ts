import { describe, expect, it } from "vitest";
import { processNames } from "./processNames";

describe("processNames", () => {
  it("names each process once, counting the ones that share a name", () => {
    const processes = [{ name: "node.exe" }, { name: "PING.EXE" }, { name: "node.exe" }];
    expect(processNames(processes)).toBe("node.exe ×2, PING.EXE");
  });

  it("names a lone process as it is", () => {
    expect(processNames([{ name: "dotnet" }])).toBe("dotnet");
  });
});
