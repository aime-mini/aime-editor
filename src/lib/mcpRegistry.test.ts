import { describe, expect, it } from "vitest";
import { collectResults, toSearchResult } from "./mcpRegistry";

/** Payload shapes captured from real registry.modelcontextprotocol.io responses. */
const NPM_SERVER = {
  name: "com.pulsemcp/remote-filesystem",
  description: "Filesystem access over MCP",
  packages: [
    {
      registryType: "npm",
      identifier: "remote-filesystem-mcp-server",
      version: "0.1.5",
      runtimeHint: "npx",
      environmentVariables: [
        { name: "API_KEY", isRequired: true },
        { name: "DEBUG", isRequired: false },
      ],
    },
  ],
  repository: { url: "https://github.com/example/remote-filesystem" },
};

const REMOTE_SERVER = {
  name: "ai.smithery/obsidian-github-mcp",
  description: "Read an Obsidian vault hosted on GitHub",
  remotes: [{ type: "streamable-http", url: "https://server.smithery.ai/@x/obsidian/mcp" }],
};

describe("toSearchResult", () => {
  it("builds an npx command and keeps only the required environment variables", () => {
    const result = toSearchResult(NPM_SERVER);
    expect(result).toMatchObject({
      name: "remote-filesystem",
      target: "npx -y remote-filesystem-mcp-server@0.1.5",
      requiredEnv: ["API_KEY"],
    });
  });

  it("prefers a hosted url over anything else", () => {
    expect(toSearchResult(REMOTE_SERVER)?.target).toBe("https://server.smithery.ai/@x/obsidian/mcp");
  });

  it("builds a uvx command for python servers", () => {
    const result = toSearchResult({
      name: "com.aws/api",
      packages: [{ registryType: "pypi", identifier: "awslabs.aws-api-mcp-server", version: "1.2.3" }],
    });
    expect(result?.target).toBe("uvx awslabs.aws-api-mcp-server@1.2.3");
  });

  it("skips servers Aime cannot actually run", () => {
    expect(
      toSearchResult({
        name: "com.example/docker-only",
        packages: [{ registryType: "oci", identifier: "example/server", version: "1" }],
      }),
    ).toBeNull();
    expect(toSearchResult({ description: "no name" })).toBeNull();
  });

  it("names a server after its publisher when the id says nothing", () => {
    // Real shape: the official Figma server is published as "com.figma/mcp".
    expect(
      toSearchResult({ name: "com.figma/mcp", remotes: [{ url: "https://mcp.figma.com/mcp" }] })?.name,
    ).toBe("figma");
    expect(
      toSearchResult({ name: "io.github.someone/server", remotes: [{ url: "https://x/mcp" }] })?.name,
    ).toBe("someone");
  });

  it("turns a namespaced id into a name a CLI accepts", () => {
    expect(
      toSearchResult({ name: "io.github.Some_Owner/My Server", remotes: [{ url: "https://x/mcp" }] })?.name,
    ).toBe("my-server");
  });
});

describe("collectResults", () => {
  it("keeps one entry per server, the last version published", () => {
    const payload = {
      servers: [
        { server: { ...NPM_SERVER, packages: [{ ...NPM_SERVER.packages[0], version: "0.1.2" }] } },
        { server: { ...NPM_SERVER, packages: [{ ...NPM_SERVER.packages[0], version: "0.1.5" }] } },
        { server: REMOTE_SERVER },
      ],
    };
    const results = collectResults(payload);
    expect(results).toHaveLength(2);
    expect(results[0].target).toBe("npx -y remote-filesystem-mcp-server@0.1.5");
  });

  it("survives an empty or unexpected payload", () => {
    expect(collectResults({ servers: [] })).toEqual([]);
    expect(collectResults(null)).toEqual([]);
    expect(collectResults({ nothing: true })).toEqual([]);
  });
});
