import { useState } from "react";
import { Pencil, Play, Plus, Workflow } from "lucide-react";
import { useT } from "../../i18n";
import { emptyFlow, slugOf } from "../../lib/flows/model";
import { useFlows } from "../../stores/flows";
import { failedTo } from "../../stores/notices";
import { useWorkspace } from "../../stores/workspace";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { PromptModal } from "../PromptModal";
import { RunDialog } from "./RunDialog";
import { useFlowsFollowWorkspace } from "./useFlowsFollowWorkspace";

/**
 * The flows of this project, in the sidebar: one line each with its last
 * run, Run and Open at hand, a new flow one click away. The designer and
 * the runs take the editor area (`FlowsView`).
 */
export function FlowsPanel() {
  const t = useT();
  const rootPath = useWorkspace((s) => s.rootPath);
  const openFlows = useWorkspace((s) => s.openFlows);
  const { flows, runs, save, remove, openDesigner, openHub } = useFlows();
  const [naming, setNaming] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ slug: string; x: number; y: number } | null>(null);
  useFlowsFollowWorkspace();

  if (rootPath === null)
    return <p className="px-3 py-3 text-[12px] text-muted">{t("flows.panel.noFolder")}</p>;

  const create = async (name: string) => {
    const slug = uniqueSlug(
      slugOf(name),
      flows.map((flow) => flow.slug),
    );
    await save(slug, emptyFlow(name));
    openDesigner(slug);
    openFlows();
  };

  const lastRunOf = (slug: string) =>
    Object.values(runs)
      .filter((run) => run.slug === slug)
      .sort((a, b) => b.startedAt - a.startedAt)
      .at(0);

  const flowRunning = running === null ? undefined : flows.find((flow) => flow.slug === running);

  return (
    <div className="flex h-full flex-col text-[12px]" data-flows-panel>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Workflow size={13} className="text-accent" />
        <button
          onClick={() => {
            openHub();
            openFlows();
          }}
          className="flex-1 text-left font-semibold hover:text-accent"
          title={t("flows.panel.hub")}
          data-flows-hub-link
        >
          {t("sidebar.flows")}
        </button>
        <button
          onClick={() => {
            setNaming(true);
          }}
          title={t("flows.panel.new")}
          className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
          data-flows-new
        >
          <Plus size={13} />
        </button>
      </div>
      {flows.length === 0 ? (
        <div className="flex flex-col items-start gap-2 px-3 py-3 text-muted">
          <p>{t("flows.panel.empty")}</p>
          <button
            onClick={() => {
              setNaming(true);
            }}
            className="rounded-md border border-line px-2 py-1 text-[11.5px] hover:border-accent hover:text-fg"
          >
            {t("flows.panel.new")}
          </button>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {flows.map((stored) => {
            const last = lastRunOf(stored.slug);
            return (
              <li
                key={stored.slug}
                className="group flex items-center gap-2 border-b border-line px-3 py-2 hover:bg-elevated/60"
                data-flows-item={stored.slug}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ slug: stored.slug, x: e.clientX, y: e.clientY });
                }}
              >
                <button
                  onClick={() => {
                    openDesigner(stored.slug);
                    openFlows();
                  }}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate font-medium">{stored.flow.name}</span>
                  <span className="block truncate text-[11px] text-muted">
                    {t("flows.designer.steps", { n: stored.flow.steps.length })}
                    {last !== undefined ? ` · ${t(`flows.status.${last.status}`)}` : ""}
                  </span>
                </button>
                <button
                  onClick={() => {
                    setRunning(stored.slug);
                  }}
                  title={t("flows.designer.run")}
                  className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-panel hover:text-accent"
                  data-flows-run={stored.slug}
                >
                  <Play size={12} />
                </button>
                <button
                  onClick={() => {
                    openDesigner(stored.slug);
                    openFlows();
                  }}
                  title={t("flows.panel.open")}
                  className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-panel hover:text-fg"
                >
                  <Pencil size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {naming && (
        <PromptModal
          title={t("flows.panel.newTitle")}
          initialValue={t("flows.panel.newDefault")}
          submitLabel={t("flows.panel.create")}
          onSubmit={(name) => {
            setNaming(false);
            void create(name).catch(failedTo(t("flows.panel.newTitle")));
          }}
          onClose={() => {
            setNaming(false);
          }}
        />
      )}
      {flowRunning !== undefined && (
        <RunDialog
          slug={flowRunning.slug}
          flow={flowRunning.flow}
          onClose={() => {
            setRunning(null);
            openFlows();
          }}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.slug)}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
    </div>
  );

  function menuItems(slug: string): MenuItem[] {
    return [
      {
        label: t("flows.panel.open"),
        icon: <Pencil size={13} />,
        onClick: () => {
          openDesigner(slug);
          openFlows();
        },
      },
      {
        label: t("flows.designer.run"),
        icon: <Play size={13} />,
        onClick: () => {
          setRunning(slug);
        },
      },
      {
        label: t("flows.panel.delete"),
        danger: true,
        onClick: () => {
          void remove(slug).catch(failedTo(t("flows.panel.delete")));
        },
      },
    ];
  }
}

function uniqueSlug(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${String(n)}`)) n += 1;
  return `${base}-${String(n)}`;
}
