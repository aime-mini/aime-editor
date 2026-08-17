import { describe, expect, it } from "vitest";
import { buildAddProviderPrompt } from "./aiProvider";

const request = {
  wanted: "gemini",
  configPath: "C:\\Users\\me\\AppData\\Roaming\\com.iodm.aiminieditor\\providers.json",
};

describe("buildAddProviderPrompt", () => {
  it("names the CLI and the exact file to edit", () => {
    const prompt = buildAddProviderPrompt(request);
    expect(prompt).toContain("gemini");
    expect(prompt).toContain(request.configPath);
  });

  it("hands over the whole schema, since an invented field fails silently", () => {
    const prompt = buildAddProviderPrompt(request);
    for (const field of [
      "`id`",
      "`displayName`",
      "`command`",
      "`args`",
      "`promptStdin`",
      "`resumeArgs`",
      "`parser`",
      "`textField`",
      "`login`",
      "`install`",
      "`apiKeyEnv`",
      "`apiKeyLoginArgs`",
      "`memory`",
      "`memoryFile`",
    ]) {
      expect(prompt).toContain(field);
    }
  });

  it("spells out the one placeholder rule that is not guessable", () => {
    // `expand` drops the whole argument that carries {model}, so a flag written
    // as its own argument survives with nothing after it - a broken command
    // line the agent has no way to infer from the CLI's help.
    expect(buildAddProviderPrompt(request)).toContain('never `["--model", "{model}"]`');
  });

  it("insists on the real binary rather than the model's memory of it", () => {
    const prompt = buildAddProviderPrompt(request);
    expect(prompt).toContain("--help");
    expect(prompt).toContain("Do not rely on memory");
    expect(prompt).toContain("Run it once");
  });

  it("protects the entries already in the file and the file itself", () => {
    const prompt = buildAddProviderPrompt(request);
    expect(prompt).toContain("Keep every entry already in it");
    expect(prompt).toContain("valid JSON");
  });

  it("keeps secrets out of a file that is not a secret store", () => {
    const prompt = buildAddProviderPrompt(request);
    expect(prompt).toContain("Do not put an API key");
  });

  it("tells the agent no restart is needed, because Aime watches the file", () => {
    expect(buildAddProviderPrompt(request)).toContain("I re-read the file by myself");
  });
});
