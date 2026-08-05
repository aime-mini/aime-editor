import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { useDebug } from "../stores/debug";

/**
 * What to pass the program: its arguments, and extra environment.
 *
 * Two text areas rather than a table, because that is how people already hold
 * both in their heads — a command line and a list of `KEY=VALUE` — and it is
 * exactly what `.aime/launch.json` stores. Arguments are split on whitespace
 * with quotes honoured, so `--name "two words"` arrives as one argument.
 */
export function LaunchArgumentsModal() {
  const targetId = useDebug((s) => s.argumentsEditor);
  const stored = useDebug((s) =>
    s.argumentsEditor === null ? undefined : s.launchOptions[s.argumentsEditor],
  );
  if (targetId === null) return null;
  // Keyed by target: switching programs remounts the form on that program's own
  // values instead of copying them in with an effect.
  return <ArgumentsForm key={targetId} targetId={targetId} initial={stored} />;
}

/**
 * Splits a command line the way a shell would, minus the shell.
 *
 * Matched without capture groups on purpose: a group that did not take part is
 * absent at run time whatever the index signature claims, and the quotes are
 * easier to strip than to type around.
 */
export function splitArguments(line: string): string[] {
  return (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
    /^["']/.test(token) ? token.slice(1, -1) : token,
  );
}

/** `KEY=VALUE` per line; a line without `=` is not a variable and is dropped. */
export function parseEnvironment(text: string): Record<string, string> {
  const entries = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line.includes("="))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()] as const;
    })
    .filter(([key]) => key !== "");
  return Object.fromEntries(entries);
}

function ArgumentsForm({
  targetId,
  initial,
}: {
  targetId: string;
  initial: { args?: string[]; env?: Record<string, string> } | undefined;
}) {
  const { setLaunchOptions, openArgumentsEditor } = useDebug();
  const [args, setArgs] = useState(() => (initial?.args ?? []).join(" "));
  const [env, setEnv] = useState(() =>
    Object.entries(initial?.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );
  const t = useT();

  const close = () => {
    openArgumentsEditor(null);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") useDebug.getState().openArgumentsEditor(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const save = () => {
    void setLaunchOptions(targetId, { args: splitArguments(args), env: parseEnvironment(env) });
    close();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24" onClick={close}>
      <div
        className="w-[520px] max-w-[92vw] space-y-3 rounded-xl border border-line bg-panel p-4 shadow-2xl"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <p className="text-xs font-semibold">{t("debug.argsTitle", { target: targetId })}</p>

        <label className="block space-y-1">
          <span className="text-[11.5px] font-medium">{t("debug.argsLabel")}</span>
          <input
            value={args}
            autoFocus
            onChange={(e) => {
              setArgs(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            placeholder="runserver --port 8080"
            className="w-full rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11.5px] outline-none focus:border-accent"
          />
          <span className="block text-[10.5px] text-muted">{t("debug.argsHint")}</span>
        </label>

        <label className="block space-y-1">
          <span className="text-[11.5px] font-medium">{t("debug.envLabel")}</span>
          <textarea
            value={env}
            rows={4}
            onChange={(e) => {
              setEnv(e.target.value);
            }}
            placeholder={"NODE_ENV=test\nLOG_LEVEL=debug"}
            className="w-full resize-y rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11.5px] outline-none focus:border-accent"
          />
          <span className="block text-[10.5px] text-muted">{t("debug.envHint")}</span>
        </label>

        <div className="flex justify-end gap-2">
          <button
            onClick={close}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:text-fg"
          >
            {t("install.close")}
          </button>
          <button
            onClick={save}
            className="rounded-lg bg-accent-strong px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            {t("debug.ruleSave")}
          </button>
        </div>
      </div>
    </div>
  );
}
