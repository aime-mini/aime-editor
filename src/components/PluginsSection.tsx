import { useEffect } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { CircleDot, FolderOpen, Loader2, Play, Puzzle, Square } from "lucide-react";
import { useT } from "../i18n";
import { PLUGIN_API_VERSION } from "../lib/plugins/protocol";
import { usePlugins, type InstalledPlugin, type PluginState } from "../stores/plugins";

/**
 * The plugins this machine has, what each one may reach, and a way to stop one.
 *
 * Every line here is a promise the sandbox has to keep: a plugin is off until it
 * is switched on, it can only use what it asked for, and it can be ended in one
 * click. Long names and long reasons are truncated with the whole text in the
 * tooltip — a settings row that pushes the dialog sideways is its own bug.
 */
export function PluginsSection() {
  const { installed, enabled, states, refresh, setEnabled, stop, restart } = usePlugins();
  const t = useT();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-2 py-1.5">
      <div className="flex items-start gap-2">
        <Puzzle size={14} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px]">
            {t("plugins.title")}{" "}
            <span className="text-muted">
              · {t("plugins.apiVersion", { version: String(PLUGIN_API_VERSION) })}
            </span>
          </p>
          <p className="text-[11px] text-muted">{t("plugins.hint")}</p>
        </div>
        <button
          onClick={() => {
            void usePlugins
              .getState()
              .openFolder()
              .then((path) => revealItemInDir(path))
              .catch(console.error);
          }}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11.5px] text-muted hover:border-accent hover:text-fg"
        >
          <FolderOpen size={12} /> {t("plugins.folder")}
        </button>
      </div>

      {installed.length === 0 ? (
        <p className="text-[11.5px] text-muted">{t("plugins.none")}</p>
      ) : (
        // Its own scroll box: twenty plugins must not turn the dialog into a
        // page, and the rest of Settings stays where it was.
        <div className="max-h-52 space-y-1 overflow-y-auto rounded-md border border-line p-1">
          {installed.map((plugin) => (
            <PluginRow
              key={plugin.manifest.id}
              plugin={plugin}
              on={enabled.includes(plugin.manifest.id)}
              state={states[plugin.manifest.id] ?? { kind: "off" }}
              onToggle={(next) => void setEnabled(plugin.manifest.id, next)}
              onStop={() => {
                stop(plugin.manifest.id, "");
              }}
              onRestart={() => void restart(plugin.manifest.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PluginRow({
  plugin,
  on,
  state,
  onToggle,
  onStop,
  onRestart,
}: {
  plugin: InstalledPlugin;
  on: boolean;
  state: PluginState;
  onToggle: (next: boolean) => void;
  onStop: () => void;
  onRestart: () => void;
}) {
  const t = useT();
  const { manifest, problem } = plugin;
  const capabilities =
    manifest.capabilities.length === 0
      ? t("plugins.noCapabilities")
      : t("plugins.capabilities", { list: manifest.capabilities.join(", ") });

  return (
    <div className="flex items-start gap-2 rounded px-1.5 py-1 hover:bg-elevated">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          onToggle(e.target.checked);
        }}
        title={t("plugins.enableNamed", { name: manifest.name })}
        className="mt-1 shrink-0 accent-accent"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px]" title={`${manifest.name} ${manifest.version}`}>
          {manifest.name}
          {manifest.version !== "" && <span className="ml-1 text-muted">{manifest.version}</span>}
        </p>
        {manifest.description !== "" && (
          <p className="truncate text-[11px] text-muted" title={manifest.description}>
            {manifest.description}
          </p>
        )}
        <p className="truncate text-[10.5px] text-muted/80" title={plugin.dir}>
          {capabilities}
        </p>
        {problem !== null && (
          <p className="truncate text-[10.5px] text-danger" title={problem}>
            {problem}
          </p>
        )}
        {state.kind === "stopped" && state.reason !== "" && (
          <p className="truncate text-[10.5px] text-warn" title={state.reason}>
            {state.reason}
          </p>
        )}
      </div>
      <StateChip state={state} />
      {state.kind === "running" ? (
        <button
          onClick={onStop}
          title={t("plugins.stop")}
          className="mt-0.5 shrink-0 rounded p-1 text-muted hover:text-danger"
        >
          <Square size={11} />
        </button>
      ) : (
        // A plugin Aime stopped has to be startable again without the user
        // having to untick and retick it.
        on &&
        state.kind === "stopped" &&
        plugin.problem === null && (
          <button
            onClick={onRestart}
            title={t("plugins.restart")}
            className="mt-0.5 shrink-0 rounded p-1 text-muted hover:text-accent"
          >
            <Play size={11} />
          </button>
        )
      )}
    </div>
  );
}

/** The state, in three words at most, and never a moving target. */
function StateChip({ state }: { state: PluginState }) {
  const t = useT();
  if (state.kind === "starting") {
    return (
      <span className="mt-0.5 flex shrink-0 items-center gap-1 text-[10.5px] text-muted">
        <Loader2 size={10} className="animate-spin" /> {t("plugins.state.starting")}
      </span>
    );
  }
  const colour = state.kind === "running" ? "text-ok" : state.kind === "stopped" ? "text-warn" : "text-muted";
  return (
    <span className={`mt-0.5 flex shrink-0 items-center gap-1 text-[10.5px] ${colour}`}>
      <CircleDot size={10} /> {t(`plugins.state.${state.kind}`)}
    </span>
  );
}
