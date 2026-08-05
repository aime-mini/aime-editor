import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { displayLine, type BreakpointRule, type EditorBreakpoint } from "../lib/dap/launch";
import { fileNameOf } from "../lib/dap/paths";
import { useDebug } from "../stores/debug";

/**
 * What makes one breakpoint fire.
 *
 * Three fields rather than one, because they are three different questions and
 * adapters treat them as such: an expression that has to hold, a hit count in
 * the adapter's own notation, and a message that turns the breakpoint into a
 * logpoint — the program keeps running and the message lands in the Debug
 * Console. Aime evaluates none of them; they travel with the breakpoint and the
 * adapter enforces them, which is the only way a loop of a million iterations
 * does not cost a million round trips.
 */
export function BreakpointRuleModal() {
  const ruleEditor = useDebug((s) => s.ruleEditor);
  const breakpoints = useDebug((s) => s.breakpoints);
  if (!ruleEditor) return null;

  const existing = (breakpoints[ruleEditor.path] ?? []).find(
    (breakpoint) => displayLine(breakpoint) === ruleEditor.line,
  );
  // Keyed by the breakpoint: picking another one remounts the form, which is how
  // it starts from that breakpoint's rules without an effect copying them in.
  return (
    <RuleForm
      key={`${ruleEditor.path}:${String(ruleEditor.line)}`}
      path={ruleEditor.path}
      line={ruleEditor.line}
      existing={existing}
    />
  );
}

function RuleForm({
  path,
  line,
  existing,
}: {
  path: string;
  line: number;
  existing: EditorBreakpoint | undefined;
}) {
  const { setBreakpointRule, closeRuleEditor } = useDebug();
  const [rule, setRule] = useState<BreakpointRule>(() => ({
    condition: existing?.condition ?? "",
    hitCondition: existing?.hitCondition ?? "",
    logMessage: existing?.logMessage ?? "",
  }));
  const t = useT();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRuleEditor();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closeRuleEditor]);

  const save = () => {
    setBreakpointRule(path, line, rule);
    closeRuleEditor();
  };

  const field = (
    key: keyof BreakpointRule,
    label: string,
    placeholder: string,
    hint: string,
    autoFocus = false,
  ) => (
    <label className="block space-y-1">
      <span className="text-[11.5px] font-medium">{label}</span>
      <input
        value={rule[key] ?? ""}
        autoFocus={autoFocus}
        onChange={(e) => {
          setRule((current) => ({ ...current, [key]: e.target.value }));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
        placeholder={placeholder}
        className="w-full rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11.5px] outline-none focus:border-accent"
      />
      <span className="block text-[10.5px] text-muted">{hint}</span>
    </label>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24"
      onClick={closeRuleEditor}
    >
      <div
        className="w-[460px] max-w-[92vw] space-y-3 rounded-xl border border-line bg-panel p-4 shadow-2xl"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <p className="text-xs font-semibold">
          {t("debug.ruleTitle", { file: fileNameOf(path), line: String(line) })}
        </p>
        {field("condition", t("debug.ruleCondition"), "i === 3", t("debug.ruleConditionHint"), true)}
        {field("hitCondition", t("debug.ruleHitCount"), "> 5", t("debug.ruleHitCountHint"))}
        {field("logMessage", t("debug.ruleLogMessage"), "value is {value}", t("debug.ruleLogMessageHint"))}
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={closeRuleEditor}
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
