/**
 * Searching the official MCP registry (registry.modelcontextprotocol.io).
 *
 * The curated catalog covers the servers most people want; this covers the
 * rest of the ecosystem without Aime pretending to know it. The mapping from
 * a registry entry to something installable is pure, so it can be tested
 * against real payloads instead of hoped about.
 */

const REGISTRY_SEARCH = "https://registry.modelcontextprotocol.io/v0/servers";
/** More than this and the list stops being a list and becomes a haystack. */
const MAX_RESULTS = 12;

export interface McpSearchResult {
  /** Short name suggested to the CLI, derived from the namespaced registry id. */
  name: string;
  /** Full registry id, shown so the publisher is visible. */
  fullName: string;
  description: string;
  /** URL of a hosted server, or the command that launches a local one. */
  target: string;
  /** Environment variables the server declares as required. */
  requiredEnv: string[];
  repository?: string;
}

interface RegistryPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
  runtimeHint?: string;
  environmentVariables?: { name?: string; isRequired?: boolean }[];
}

interface RegistryServer {
  name?: string;
  description?: string;
  version?: string;
  repository?: { url?: string };
  remotes?: { type?: string; url?: string }[];
  packages?: RegistryPackage[];
}

/** Last segments that say nothing: publishers often call the server just "mcp". */
const MEANINGLESS_NAMES = new Set(["mcp", "server", "mcp-server", "main", "app"]);
/** Namespace parts that are addressing, not identity. */
const NAMESPACE_NOISE = new Set(["com", "io", "ai", "org", "net", "dev", "app", "github", "gitlab"]);

function sanitize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * `io.github.owner/my-server` → `my-server`. When the last segment says
 * nothing (`com.figma/mcp`), the publisher is the better name - "figma" is
 * what the user will look for in their server list, not "mcp".
 */
function shortName(fullName: string): string {
  const segments = fullName.split("/");
  const name = sanitize(segments[segments.length - 1]);
  if (name && !MEANINGLESS_NAMES.has(name)) return name;
  const publisher = segments[0]
    .split(".")
    .map(sanitize)
    .filter((part) => part && !NAMESPACE_NOISE.has(part))
    .pop();
  return publisher ?? (name || "server");
}

/**
 * The command that runs a package, or null when Aime cannot run it: the
 * registry also lists Docker and NuGet servers, and offering those as if they
 * were one click away would be a lie.
 */
function commandFor(pkg: RegistryPackage): string | null {
  if (!pkg.identifier) return null;
  const pinned = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;
  if (pkg.runtimeHint === "npx" || pkg.registryType === "npm") return `npx -y ${pinned}`;
  if (pkg.runtimeHint === "uvx" || pkg.registryType === "pypi") return `uvx ${pinned}`;
  return null;
}

/** Maps one registry entry to something installable; null when nothing fits. */
export function toSearchResult(server: RegistryServer): McpSearchResult | null {
  const fullName = server.name;
  if (!fullName) return null;

  const remote = server.remotes?.find((candidate) => candidate.url);
  const pkg = server.packages?.find((candidate) => commandFor(candidate));
  const target = remote?.url ?? (pkg ? commandFor(pkg) : null);
  if (!target) return null;

  return {
    name: shortName(fullName),
    fullName,
    description: server.description ?? "",
    target,
    requiredEnv: (pkg?.environmentVariables ?? [])
      .filter((variable) => variable.isRequired && variable.name)
      .map((variable) => variable.name ?? ""),
    repository: server.repository?.url,
  };
}

/**
 * The registry lists every published version of a server, so the same name
 * arrives many times; the newest entry wins because versions come in order.
 */
export function collectResults(payload: unknown): McpSearchResult[] {
  const servers = (payload as { servers?: { server?: RegistryServer }[] } | null)?.servers ?? [];
  const byName = new Map<string, McpSearchResult>();
  for (const entry of servers) {
    const result = entry.server ? toSearchResult(entry.server) : null;
    if (result) byName.set(result.fullName, result);
  }
  return [...byName.values()].slice(0, MAX_RESULTS);
}

/** Searches the registry; an unreachable registry is an empty list, not a crash. */
export async function searchMcpServers(query: string, signal?: AbortSignal): Promise<McpSearchResult[]> {
  const url = `${REGISTRY_SEARCH}?search=${encodeURIComponent(query)}&limit=50`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`registry answered ${String(response.status)}`);
  return collectResults(await response.json());
}
