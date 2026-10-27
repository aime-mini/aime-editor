import { describe, expect, it } from "vitest";
import { buildDiscoverBuildPrompt, parseDiscoveredBuild } from "./aiBuild";

const FALLBACK = {
  target: "src/Presentation/Nop.Web/Nop.Web.csproj",
  dir: "src/Presentation/Nop.Web",
};

describe("the brief", () => {
  it("names the program, its folder, and what Aime would do without an answer", () => {
    const prompt = buildDiscoverBuildPrompt(FALLBACK);
    expect(prompt).toContain(FALLBACK.target);
    expect(prompt).toContain(FALLBACK.dir);
    expect(prompt).toContain("builds that program alone");
  });

  it("says that the default being right is an answer", () => {
    // Without this the model has to invent something to say, and an invented
    // build command is worse than the one Aime already had.
    expect(buildDiscoverBuildPrompt(FALLBACK)).toContain('{"command":""}');
  });

  it("asks for the file the command was read from", () => {
    expect(buildDiscoverBuildPrompt(FALLBACK)).toContain("`source` names the file you read it from");
  });
});

describe("reading the answer", () => {
  it("takes a command that cites where it came from", () => {
    const answer = '{"command":"dotnet build src/NopCommerce.sln","source":"src/NopCommerce.sln"}';
    expect(parseDiscoveredBuild(answer)).toEqual({
      command: "dotnet build src/NopCommerce.sln",
      source: "src/NopCommerce.sln",
    });
  });

  it("finds the answer inside prose, the way a CLI tends to reply", () => {
    const answer = [
      "I read the solution and the plugin projects.",
      '{"command":"dotnet build src/NopCommerce.sln","source":"src/NopCommerce.sln"}',
      "That builds the plugins too.",
    ].join("\n");
    expect(parseDiscoveredBuild(answer)?.command).toBe("dotnet build src/NopCommerce.sln");
  });

  it("refuses a command with nothing behind it", () => {
    // A command the model cannot cite is indistinguishable from its general
    // knowledge of the ecosystem, which is what this whole brief avoids.
    expect(parseDiscoveredBuild('{"command":"dotnet build App.sln"}')).toBeNull();
  });

  it("reads an empty command as the default being right", () => {
    expect(parseDiscoveredBuild('{"command":""}')).toBeNull();
  });

  it("reads a reply that is only prose as nothing to do", () => {
    expect(parseDiscoveredBuild("I could not find a solution file.")).toBeNull();
  });

  it("survives a reply that is not JSON at all", () => {
    expect(parseDiscoveredBuild("{ not json")).toBeNull();
  });
});
