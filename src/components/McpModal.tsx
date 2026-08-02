import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { KeyRound, Loader2, Plug, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useT } from "../i18n";
import { MCP_CATALOG, MCP_GROUP_LABELS, resolveTarget, type McpCatalogGroup } from "../lib/mcpCatalog";
import { searchMcpServers, type McpSearchResult } from "../lib/mcpRegistry";
import { capabilitiesOf } from "../lib/providers";
import { useAi } from "../stores/ai";
import { runInTerminal } from "../stores/terminals";
import { useWorkspace } from "../stores/workspace";

/** Mirror of the Rust `McpServer` (mcp.rs). */
interface McpServer {
  name: string;
  target: string;
  status: string;
}

const EMPTY_FORM = { name: "", target: "", env: "" };
/** Long enough that typing a package name does not fire a request per keystroke. */
const SEARCH_DEBOUNCE_MS = 350;

/**
 * MCP servers of the selected AI CLI (ARCHITECTURE.md §7). Aime drives the
 * CLI's own `mcp` commands rather than editing its config: the servers stay
 * exactly where the CLI expects them, and its health checks and OAuth keep
 * working. Adding one here is the whole "AI plugins" story - no plugin API.
 */
export function McpModal({ onClose }: { onClose: () => void }) {
  const rootPath = useWorkspace((s) => s.rootPath);
  const providerId = useAi((s) => s.providerId);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [adding, setAdding] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<McpSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  // State is only written from the promise callbacks, so the initial load can
  // run in an effect without a synchronous render cascade.
  const refresh = useCallback(
    () =>
      invoke<McpServer[]>("mcp_list", { providerId, cwd: rootPath })
        .then((list) => {
          setServers(list);
          setError(null);
        })
        .catch((err: unknown) => {
          setError(String(err));
        })
        .finally(() => {
          setLoading(false);
        }),
    [providerId, rootPath],
  );

  // Listing health-checks every server, so it runs on demand - never per render.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    // Clearing results is an event, handled where the query changes; this
    // effect only ever starts a search.
    const needle = query.trim();
    if (!catalogOpen || needle.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      searchMcpServers(needle, controller.signal)
        .then(setFound)
        .catch((err: unknown) => {
          if (!controller.signal.aborted) setError(String(err));
        })
        .finally(() => {
          setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, catalogOpen]);

  /** Picking anything only fills the form - nothing is configured behind the user's back. */
  const fillForm = (name: string, target: string, requiredEnv: string[] = []) => {
    setForm({ name, target, env: requiredEnv.map((variable) => `${variable}=`).join("\n") });
    setCatalogOpen(false);
    setQuery("");
  };

  const add = async () => {
    const name = form.name.trim();
    const target = form.target.trim();
    if (!name || !target || adding) return;
    setAdding(true);
    setError(null);
    try {
      await invoke("mcp_add", {
        providerId,
        cwd: rootPath,
        spec: {
          name,
          target,
          env: form.env
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.includes("=")),
        },
      });
      setForm(EMPTY_FORM);
      await refresh();
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (name: string) => {
    setBusyName(name);
    setError(null);
    try {
      await invoke("mcp_remove", { providerId, cwd: rootPath, name });
      setConfirmRemove(null);
      await refresh();
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setBusyName(null);
    }
  };

  const signIn = async (name: string) => {
    try {
      runInTerminal(await invoke<string>("mcp_login_command", { providerId, name }), name);
      onClose();
    } catch (err: unknown) {
      setError(String(err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-16" onClick={onClose}>
      <div
        className="flex max-h-[75vh] w-[640px] max-w-[92vw] flex-col rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Plug size={15} className="shrink-0 text-accent" />
          <span className="text-xs font-semibold">
            {t("mcp.title", { provider: capabilitiesOf(providerId).displayName })}
          </span>
          <span className="flex-1" />
          <button
            onClick={() => {
              setLoading(true);
              void refresh();
            }}
            disabled={loading}
            className="rounded p-1 text-muted hover:bg-elevated hover:text-fg disabled:opacity-40"
            title={t("mcp.refresh")}
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-elevated hover:text-fg">
            <X size={14} />
          </button>
        </div>

        <p className="border-b border-line px-4 py-2 text-[11px] text-muted">{t("mcp.hint")}</p>

        {error && (
          <div className="border-b border-danger/40 bg-danger/10 px-4 py-1.5 text-[12px] text-danger">
            {error}
          </div>
        )}

        <div className="min-h-24 flex-1 overflow-y-auto px-2 py-2">
          {servers.length === 0 && !loading && (
            <p className="px-2 py-6 text-center text-[12px] text-muted">{t("mcp.empty")}</p>
          )}
          {servers.map((server) => (
            <div
              key={server.name}
              className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-elevated"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px]">{server.name}</p>
                <p className="truncate font-mono text-[11px] text-muted">{server.target}</p>
              </div>
              {server.status && <span className="shrink-0 text-[11px] text-warn">{server.status}</span>}
              {confirmRemove === server.name ? (
                <>
                  <button
                    onClick={() => void remove(server.name)}
                    disabled={busyName === server.name}
                    className="shrink-0 rounded-md bg-danger px-2 py-1 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
                  >
                    {t("mcp.remove")}
                  </button>
                  <button
                    onClick={() => {
                      setConfirmRemove(null);
                    }}
                    className="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] text-muted hover:text-fg"
                  >
                    {t("mcp.cancel")}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => void signIn(server.name)}
                    className="shrink-0 rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-fg"
                    title={t("mcp.signIn")}
                  >
                    <KeyRound size={13} />
                  </button>
                  <button
                    onClick={() => {
                      setConfirmRemove(server.name);
                    }}
                    className="shrink-0 rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-danger"
                    title={t("mcp.remove")}
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>

        {catalogOpen && (
          <div className="flex max-h-64 flex-col border-t border-line">
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                // Below two characters there is nothing to show but the catalog.
                if (e.target.value.trim().length < 2) setFound(null);
              }}
              placeholder={t("mcp.searchPlaceholder")}
              className="border-b border-line bg-transparent px-4 py-2 text-[12px] outline-none placeholder:text-muted"
            />
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
              {found === null ? (
                <>
                  {(Object.keys(MCP_GROUP_LABELS) as McpCatalogGroup[]).map((group) => (
                    <div key={group} className="mb-2">
                      <p className="mb-1 text-[10px] font-semibold tracking-wider text-muted uppercase">
                        {t(MCP_GROUP_LABELS[group])}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {MCP_CATALOG.filter((entry) => entry.group === group).map((entry) => (
                          <button
                            key={entry.name}
                            onClick={() => {
                              fillForm(entry.name, resolveTarget(entry, rootPath));
                            }}
                            title={`${t(entry.hint)}${entry.needsKey ? ` - ${t("mcp.needsKey")}` : ""}`}
                            className="rounded-md border border-line px-2 py-1 text-[11.5px] text-muted hover:border-accent hover:text-fg"
                          >
                            {entry.label}
                            {entry.needsKey && <span className="ml-1 text-warn">*</span>}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  <p className="text-[10px] text-muted">{t("mcp.catalogFooter")}</p>
                </>
              ) : (
                <>
                  {searching && <p className="py-2 text-[11px] text-muted">{t("mcp.searching")}</p>}
                  {!searching && found.length === 0 && (
                    <p className="py-2 text-[11px] text-muted">{t("mcp.searchEmpty")}</p>
                  )}
                  {found.map((result) => (
                    <button
                      key={result.fullName}
                      onClick={() => {
                        fillForm(result.name, result.target, result.requiredEnv);
                      }}
                      className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-elevated"
                    >
                      <span className="text-[12px]">
                        {result.name}
                        <span className="ml-1.5 text-[10px] text-muted">{result.fullName}</span>
                        {result.requiredEnv.length > 0 && <span className="ml-1 text-warn">*</span>}
                      </span>
                      <span className="truncate text-[11px] text-muted">{result.description}</span>
                      <span className="truncate font-mono text-[10px] text-muted">{result.target}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2 border-t border-line px-4 py-3">
          <div className="flex gap-2">
            <input
              value={form.name}
              onChange={(e) => {
                setForm({ ...form, name: e.target.value });
              }}
              placeholder={t("mcp.namePlaceholder")}
              className="w-40 rounded-md border border-line bg-elevated px-2 py-1 text-[12px] outline-none focus:border-accent"
            />
            <input
              value={form.target}
              onChange={(e) => {
                setForm({ ...form, target: e.target.value });
              }}
              placeholder={t("mcp.targetPlaceholder")}
              className="flex-1 rounded-md border border-line bg-elevated px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
            />
          </div>
          <textarea
            value={form.env}
            onChange={(e) => {
              setForm({ ...form, env: e.target.value });
            }}
            placeholder={t("mcp.envPlaceholder")}
            rows={2}
            className="resize-none rounded-md border border-line bg-elevated px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setCatalogOpen((open) => !open);
                setFound(null);
                setQuery("");
              }}
              className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-muted hover:border-accent hover:text-fg"
            >
              <Search size={12} /> {t("mcp.browseCatalog")}
            </button>
            <span className="flex-1 text-[10px] text-muted">{t("mcp.footer")}</span>
            <button
              onClick={() => void add()}
              disabled={!form.name.trim() || !form.target.trim() || adding}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {adding ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              {t("mcp.add")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
