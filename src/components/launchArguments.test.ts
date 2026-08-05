import { describe, expect, it } from "vitest";
import { parseEnvironment, splitArguments } from "./LaunchArgumentsModal";

describe("splitArguments", () => {
  it("splits a command line the way the program will see it", () => {
    expect(splitArguments("runserver --port 8080")).toEqual(["runserver", "--port", "8080"]);
  });

  it("keeps a quoted phrase together, which is the whole reason for quotes", () => {
    expect(splitArguments('--name "two words" --flag')).toEqual(["--name", "two words", "--flag"]);
    expect(splitArguments("--path 'a b'")).toEqual(["--path", "a b"]);
  });

  it("has nothing to pass for an empty line", () => {
    expect(splitArguments("   ")).toEqual([]);
  });
});

describe("parseEnvironment", () => {
  it("reads one KEY=VALUE per line", () => {
    expect(parseEnvironment("NODE_ENV=test\nLOG=debug")).toEqual({ NODE_ENV: "test", LOG: "debug" });
  });

  it("keeps everything after the first = , because values contain them", () => {
    expect(parseEnvironment("URL=postgres://u:p@host/db?x=1")).toEqual({
      URL: "postgres://u:p@host/db?x=1",
    });
  });

  it("drops a line that is not a variable rather than inventing one", () => {
    expect(parseEnvironment("just a note\n=novalue\nA=1")).toEqual({ A: "1" });
  });
});
