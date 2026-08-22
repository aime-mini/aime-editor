import type { TranslationKey } from "../i18n/en";

/**
 * A curated list of MCP servers offered as one-click starting points.
 *
 * Every entry is verified, because a wrong address only fails after the user
 * has already trusted it: the hosted URLs are exactly the connectors the
 * Claude Code CLI itself lists, and every npm package was checked to exist on
 * the registry (versions confirmed 2026-08-02).
 *
 * Picking an entry fills the add form rather than adding straight away, so the
 * user always sees what is about to be configured - and can change the name,
 * the path, or drop it entirely.
 */
export type McpCatalogGroup = "boards" | "design" | "docs" | "cloud" | "local";

export interface McpCatalogEntry {
  /** Suggested server name; editable before adding. */
  name: string;
  label: string;
  group: McpCatalogGroup;
  /** URL of a hosted server, or the command that launches a local one. */
  target: string;
  /** One line on what the server gives the AI. */
  hint: TranslationKey;
  /** true when `{root}` must become the workspace path. */
  needsRoot?: boolean;
  /**
   * true when `{organization}` must become an Azure DevOps organization. Filled
   * in from a connected board (Work items panel) when there is one, so the two
   * halves of the same integration agree; otherwise the form shows a placeholder
   * for the user to replace.
   */
  needsOrganization?: boolean;
  /** true when the server only works after an API key is set as an env variable. */
  needsKey?: boolean;
}

/** Section titles, in the order the picker shows them. */
export const MCP_GROUP_LABELS: Record<McpCatalogGroup, TranslationKey> = {
  boards: "mcp.group.boards",
  design: "mcp.group.design",
  docs: "mcp.group.docs",
  cloud: "mcp.group.cloud",
  local: "mcp.group.local",
};

export const MCP_CATALOG: McpCatalogEntry[] = [
  // --- Issue trackers and boards ---
  {
    name: "linear",
    label: "Linear",
    group: "boards",
    target: "https://mcp.linear.app/mcp",
    hint: "mcp.catalog.linear",
  },
  {
    name: "atlassian",
    label: "Jira & Confluence",
    group: "boards",
    target: "https://mcp.atlassian.com/v1/mcp",
    hint: "mcp.catalog.atlassian",
  },
  {
    name: "asana",
    label: "Asana",
    group: "boards",
    target: "https://mcp.asana.com/sse",
    hint: "mcp.catalog.asana",
  },
  {
    name: "monday",
    label: "monday.com",
    group: "boards",
    target: "https://mcp.monday.com/mcp",
    hint: "mcp.catalog.monday",
  },
  {
    name: "azure-devops",
    label: "Azure DevOps",
    group: "boards",
    // First-party: github.com/microsoft/azure-devops-mcp, verified on npm
    // 2026-08-18 (v2.9.0). `--help` says the organization is a positional
    // argument and sign-in is interactive unless told otherwise.
    target: "npx -y @azure-devops/mcp {organization}",
    hint: "mcp.catalog.azureDevOps",
    needsOrganization: true,
  },
  {
    name: "github",
    label: "GitHub",
    group: "boards",
    target: "npx -y @modelcontextprotocol/server-github",
    hint: "mcp.catalog.github",
    needsKey: true,
  },

  // --- Design ---
  {
    name: "figma",
    label: "Figma",
    group: "design",
    target: "https://mcp.figma.com/mcp",
    hint: "mcp.catalog.figma",
  },
  {
    name: "canva",
    label: "Canva",
    group: "design",
    target: "https://mcp.canva.com/mcp",
    hint: "mcp.catalog.canva",
  },

  // --- Documents, knowledge and customers ---
  {
    name: "notion",
    label: "Notion",
    group: "docs",
    target: "https://mcp.notion.com/mcp",
    hint: "mcp.catalog.notion",
  },
  { name: "box", label: "Box", group: "docs", target: "https://mcp.box.com", hint: "mcp.catalog.box" },
  {
    name: "intercom",
    label: "Intercom",
    group: "docs",
    target: "https://mcp.intercom.com/mcp",
    hint: "mcp.catalog.intercom",
  },
  {
    name: "hubspot",
    label: "HubSpot",
    group: "docs",
    target: "https://mcp.hubspot.com/anthropic",
    hint: "mcp.catalog.hubspot",
  },
  {
    name: "context7",
    label: "Context7 docs",
    group: "docs",
    target: "npx -y @upstash/context7-mcp",
    hint: "mcp.catalog.context7",
  },

  // --- Cloud platforms (first-party servers only) ---
  {
    name: "azure",
    label: "Azure",
    group: "cloud",
    target: "npx -y @azure/mcp@latest server start",
    hint: "mcp.catalog.azure",
    needsKey: true,
  },
  {
    name: "aws",
    label: "AWS",
    group: "cloud",
    target: "uvx awslabs.aws-api-mcp-server@latest",
    hint: "mcp.catalog.aws",
    needsKey: true,
  },
  {
    name: "cloudflare",
    label: "Cloudflare",
    group: "cloud",
    target: "npx -y @cloudflare/mcp-server-cloudflare",
    hint: "mcp.catalog.cloudflare",
    needsKey: true,
  },
  {
    name: "supabase",
    label: "Supabase",
    group: "cloud",
    target: "npx -y @supabase/mcp-server-supabase",
    hint: "mcp.catalog.supabase",
    needsKey: true,
  },

  // --- Local tools, no account needed ---
  {
    name: "filesystem",
    label: "Filesystem",
    group: "local",
    target: "npx -y @modelcontextprotocol/server-filesystem {root}",
    hint: "mcp.catalog.filesystem",
    needsRoot: true,
  },
  {
    name: "memory",
    label: "Memory",
    group: "local",
    target: "npx -y @modelcontextprotocol/server-memory",
    hint: "mcp.catalog.memory",
  },
  {
    name: "sequential-thinking",
    label: "Sequential thinking",
    group: "local",
    target: "npx -y @modelcontextprotocol/server-sequential-thinking",
    hint: "mcp.catalog.sequentialThinking",
  },
  {
    name: "playwright",
    label: "Playwright browser",
    group: "local",
    target: "npx -y @playwright/mcp",
    hint: "mcp.catalog.playwright",
  },
  {
    name: "postgres",
    label: "PostgreSQL",
    group: "local",
    target: "npx -y @modelcontextprotocol/server-postgres",
    hint: "mcp.catalog.postgres",
    needsKey: true,
  },
];

/**
 * Fills the placeholders an entry declares: `{root}` from the open workspace
 * (quoted, because paths have spaces) and `{organization}` from a connected
 * board. What cannot be filled stays readable, since the picker only fills the
 * form and the user edits it before adding.
 */
export function resolveTarget(
  entry: McpCatalogEntry,
  rootPath: string | null,
  organization: string | null,
): string {
  let target = entry.target;
  if (entry.needsRoot) {
    target = target.replace("{root}", rootPath === null ? "." : `"${rootPath}"`);
  }
  if (entry.needsOrganization) {
    target = target.replace("{organization}", organization ?? "your-organization");
  }
  return target;
}
