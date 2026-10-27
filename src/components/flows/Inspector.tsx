import { useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FlaskConical,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { useT } from "../../i18n";
import type { TranslationKey } from "../../i18n/en";
import { COMPILED_ABILITIES, compileStep, needsCompiling } from "../../lib/flows/compiler";
import type {
  Flow,
  GitConfig,
  HttpConfig,
  InputHint,
  Invocation,
  OnError,
  Permission,
  PlatformCommand,
  ServiceConfig,
  Step,
  StepConfig,
} from "../../lib/flows/model";
import { MAX_WAIT_SECONDS, type Problem } from "../../lib/flows/validate";
import { modelsOf } from "../../lib/providers";
import { useAi } from "../../stores/ai";
import { latestRun, sampleScopeFor, stepInputIn, useFlows } from "../../stores/flows";
import { failedTo } from "../../stores/notices";
import { useTasks } from "../../stores/tasks";
import { abilityOf } from "./abilities";
import { DataView, LogView } from "./StepData";
import { StepGuide, useStepGuideOpen } from "./StepGuide";

/**
 * The selected step, as the design draws it: what kind of step and a "?"
 * that explains it; four tabs - its settings, what it was given, what it
 * produced and what it logged in the last run; the fields every step has
 * (name, what it does, what to do on an error), the ability's own, and the
 * rarely-touched ones folded under Advanced. "Try this step" runs just this
 * one on the last run's data. Every change goes straight to the flow.
 */
export function Inspector({
  slug,
  flow,
  step,
  problems,
  onChange,
  onChangeFlow,
  onRemove,
}: {
  slug: string;
  flow: Flow;
  step: Step;
  problems: Problem[];
  onChange: (step: Step) => void;
  onChangeFlow: (flow: Flow) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const look = abilityOf(step);
  const Icon = look.icon;
  const own = problems.filter((problem) => problem.at === step.id);
  const isInput = step.config.ability === "input";
  const [tab, setTab] = useState<"config" | "input" | "output" | "log">("config");
  const [help, setHelp] = useStepGuideOpen();
  const [advanced, setAdvanced] = useState(false);
  const lastRun = useFlows((s) => latestRun(s.runs, slug));
  const view = lastRun?.steps[step.id];
  const trying = useFlows((s) => s.trying === step.id);
  const tryStep = useFlows((s) => s.tryStep);
  const root = useFlows((s) => s.root);
  const runs = useFlows((s) => s.runs);
  const [compiling, setCompiling] = useState(false);
  const patch = (changes: Partial<Step>) => {
    onChange({ ...step, ...changes });
  };
  const patchConfig = (changes: Partial<StepConfig>) => {
    onChange({ ...step, config: { ...step.config, ...changes } as StepConfig });
  };
  const upstream = flow.wires
    .filter((wire) => wire.to === step.id)
    .map((wire) => flow.steps.find((candidate) => candidate.id === wire.from))
    .filter((candidate): candidate is Step => candidate !== undefined);

  return (
    <div className="flex h-full flex-col text-[12px]" data-flow-inspector={step.id}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className={`grid size-5 place-items-center rounded-md ${look.swatch}`}>
          <Icon size={12} strokeWidth={2.4} />
        </span>
        <span className="flex-1 text-[11px] font-semibold tracking-wider text-muted uppercase">
          {t(look.label)}
        </span>
        <button
          onClick={() => {
            setHelp(!help);
          }}
          title={t("flows.inspector.help")}
          className={`rounded p-1 hover:bg-elevated ${help ? "text-accent" : "text-muted hover:text-fg"}`}
          data-flow-help
        >
          <CircleHelp size={14} />
        </button>
        {!isInput && (
          <button
            onClick={onRemove}
            title={t("flows.inspector.remove")}
            className="rounded p-1 text-muted hover:bg-elevated hover:text-danger"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {help && (
        <StepGuide
          step={step}
          onClose={() => {
            setHelp(false);
          }}
        />
      )}
      <div className="flex border-b border-line text-[11px]">
        {(["config", "input", "output", "log"] as const).map((name) => (
          <button
            key={name}
            onClick={() => {
              setTab(name);
            }}
            className={`flex-1 border-b-2 py-1.5 ${tab === name ? "border-accent text-accent" : "border-transparent text-muted hover:text-fg"}`}
          >
            {t(`flows.inspector.tab.${name}`)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "config" && (
          <div className="flex flex-col gap-3 px-3 py-3">
            {own.map((problem) => (
              <p
                key={problem.message}
                className={`rounded-md px-2 py-1 text-[11px] ${problem.kind === "error" ? "bg-danger/10 text-danger" : "bg-warn/10 text-warn"}`}
              >
                {problem.message}
              </p>
            ))}
            <Field label={t("flows.inspector.name")}>
              <input
                value={step.name}
                onChange={(e) => {
                  patch({ name: e.target.value });
                }}
                className={input}
              />
            </Field>
            {isInput ? (
              <InputStepFields flow={flow} onChangeFlow={onChangeFlow} />
            ) : (
              <>
                <DoesField step={step} upstream={upstream} onChange={patch} />
                {COMPILED_ABILITIES.includes(step.config.ability) && step.does.trim() !== "" && (
                  <div className="flex flex-col items-start gap-1.5">
                    {needsCompiling(step) && (
                      <p className="flex items-start gap-1.5 rounded-md bg-accent-soft px-2 py-1.5 text-[11.5px] text-accent">
                        <Wand2 size={12} className="mt-0.5 shrink-0" />
                        {t("flows.inspector.compileNeeded")}
                      </p>
                    )}
                    <button
                      onClick={() => {
                        if (root === null) return;
                        setCompiling(true);
                        compileStep(flow, step, sampleScopeFor(runs, slug, flow, step.id), root)
                          .then(onChange)
                          .catch(failedTo(t("flows.inspector.compile")))
                          .finally(() => {
                            setCompiling(false);
                          });
                      }}
                      disabled={compiling}
                      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] whitespace-nowrap ${
                        needsCompiling(step)
                          ? "bg-accent-strong font-medium text-white hover:opacity-90"
                          : "border border-line text-muted hover:border-accent hover:text-fg"
                      }`}
                      data-flow-compile
                    >
                      {compiling ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                      {t("flows.inspector.compile")}
                    </button>
                  </div>
                )}
                <AbilityFields step={step} patchConfig={patchConfig} />
                {step.config.ability !== "human" && step.config.ability !== "gate" && (
                  <Field label={t("flows.inspector.onError")}>
                    <Segmented
                      value={step.onError}
                      options={[
                        ["stop", t("flows.onError.stop")],
                        ["errorWire", t("flows.onError.errorWire")],
                        ...(step.forEach === true
                          ? ([["skipItems", t("flows.onError.skipItems")]] as [OnError, string][])
                          : []),
                      ]}
                      onChange={(onError) => {
                        patch({ onError });
                      }}
                    />
                  </Field>
                )}
                <button
                  onClick={() => {
                    setAdvanced(!advanced);
                  }}
                  className="flex items-center gap-1 self-start text-[11.5px] text-muted hover:text-fg"
                >
                  {advanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{" "}
                  {t("flows.inspector.advanced")}
                  <span className="text-[10.5px] text-muted/70">{t("flows.inspector.advancedHint")}</span>
                </button>
                {advanced && (
                  <AdvancedFields
                    step={step}
                    parallel={flow.settings.parallel}
                    patch={patch}
                    patchConfig={patchConfig}
                  />
                )}
                <div className="flex flex-col items-start gap-1.5 border-t border-line pt-3">
                  <button
                    onClick={() => {
                      setTab("output");
                      tryStep(slug, step.id).catch(failedTo(t("flows.inspector.try")));
                    }}
                    disabled={trying}
                    className="flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[11.5px] whitespace-nowrap text-muted hover:border-accent hover:text-fg disabled:opacity-50"
                    data-flow-try
                  >
                    {trying ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />}{" "}
                    {t("flows.inspector.try")}
                  </button>
                  <span className="text-[10.5px] text-muted">
                    {lastRun === undefined
                      ? t("flows.inspector.tryNoRun")
                      : t("flows.inspector.tryWith", { run: lastRun.id })}
                  </span>
                </div>
              </>
            )}
          </div>
        )}
        {tab === "input" && (
          <DataView
            title={t("flows.inspector.inputOf")}
            value={stepInputIn(lastRun, flow, step.id)}
            empty={t("flows.inspector.noRun")}
          />
        )}
        {tab === "output" && (
          <DataView
            title={view?.summary ?? ""}
            value={view?.output?.value}
            error={view?.error ?? undefined}
            empty={t("flows.inspector.noRun")}
          />
        )}
        {tab === "log" && <LogView lines={view?.log} empty={t("flows.inspector.noRun")} />}
      </div>
    </div>
  );
}

const input =
  "w-full rounded border border-line bg-elevated px-2 py-1.5 text-[12px] outline-none focus:border-accent";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-muted">{label}</span>
      {children}
      {hint !== undefined && <span className="text-[10.5px] text-muted/80">{hint}</span>}
    </label>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded border border-line text-[11.5px]">
      {options.map(([key, label]) => (
        <button
          key={key}
          onClick={() => {
            onChange(key);
          }}
          className={`flex-1 px-2 py-1 ${value === key ? "bg-accent-soft text-accent" : "text-muted hover:bg-elevated hover:text-fg"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** "What it does", with the earlier steps as chips that insert their result where the cursor is. */
function DoesField({
  step,
  upstream,
  onChange,
}: {
  step: Step;
  upstream: Step[];
  onChange: (changes: Partial<Step>) => void;
}) {
  const t = useT();
  const area = useRef<HTMLTextAreaElement>(null);
  const insert = (text: string) => {
    const element = area.current;
    const at = element?.selectionStart ?? step.does.length;
    const does = `${step.does.slice(0, at)}${text}${step.does.slice(at)}`;
    onChange({ does });
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(at + text.length, at + text.length);
    });
  };
  return (
    <Field
      label={t("flows.inspector.does")}
      hint={t(`flows.inspector.does.${step.config.ability}` as TranslationKey)}
    >
      <textarea
        ref={area}
        value={step.does}
        onChange={(e) => {
          onChange({ does: e.target.value });
        }}
        placeholder={t(`flows.inspector.doesExample.${step.config.ability}` as TranslationKey)}
        rows={4}
        className={`${input} resize-y`}
      />
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[10.5px] text-muted">{t("flows.inspector.from")}</span>
        {upstream.length === 0 && (
          <span className="text-[10.5px] text-muted/70">{t("flows.inspector.fromNone")}</span>
        )}
        {upstream.map((source) => (
          <span
            key={source.id}
            className="flex items-center overflow-hidden rounded-md border border-line text-[10.5px]"
          >
            <button
              onClick={() => {
                insert(`{{${source.id}.value}}`);
              }}
              className="px-1.5 py-0.5 hover:bg-elevated"
              title={t("flows.inspector.insertValue")}
            >
              {source.name}
            </button>
            <button
              onClick={() => {
                insert(`{{${source.id}.summary}}`);
              }}
              className="border-l border-line px-1 py-0.5 text-muted hover:bg-elevated"
              title={t("flows.inspector.insertSummary")}
            >
              Σ
            </button>
          </span>
        ))}
        <button
          onClick={() => {
            insert("{{input.text}}");
          }}
          className="rounded-md border border-line px-1.5 py-0.5 text-[10.5px] hover:bg-elevated"
          title={t("flows.inspector.insertInput")}
        >
          {t("flows.ability.input")}
        </button>
      </div>
    </Field>
  );
}

/** The input step: what a run expects, as the design's hints and parameters, and the flow's own settings. */
function InputStepFields({ flow, onChangeFlow }: { flow: Flow; onChangeFlow: (flow: Flow) => void }) {
  const t = useT();
  const hints = flow.input.hints;
  const setHints = (next: InputHint[]) => {
    onChangeFlow({ ...flow, input: { hints: next } });
  };
  const update = (index: number, changes: Partial<InputHint>) => {
    setHints(hints.map((hint, i) => (i === index ? { ...hint, ...changes } : hint)));
  };
  return (
    <>
      <p className="rounded-md bg-elevated px-2 py-1.5 text-[11px] leading-relaxed text-muted">
        {t("flows.inspector.inputExplain")}
      </p>
      <Field label={t("flows.inspector.hints")} hint={t("flows.inspector.hintsHint")}>
        <div className="flex flex-col gap-1.5">
          {hints.map((hint, index) => (
            <div key={index} className="rounded-md border border-line p-1.5">
              <div className="flex items-center gap-1">
                <input
                  value={hint.name}
                  placeholder={t("flows.inspector.hintName")}
                  onChange={(e) => {
                    update(index, { name: e.target.value });
                  }}
                  className={`${input} flex-1`}
                />
                <select
                  value={hint.kind ?? ""}
                  onChange={(e) => {
                    update(index, {
                      kind: e.target.value === "" ? undefined : (e.target.value as InputHint["kind"]),
                    });
                  }}
                  className={`${input} w-24 shrink-0`}
                >
                  <option value="">{t("flows.inspector.hintAny")}</option>
                  {(["file", "folder", "image", "ticket", "pr", "link", "run"] as const).map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`flows.kind.${kind}`)}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    setHints(hints.filter((_, i) => i !== index));
                  }}
                  className="shrink-0 rounded p-1 text-muted hover:text-danger"
                  title={t("flows.inspector.remove")}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="mt-1 flex items-center gap-1">
                <input
                  value={hint.default ?? ""}
                  placeholder={t("flows.inspector.hintDefault")}
                  onChange={(e) => {
                    update(index, { default: e.target.value === "" ? undefined : e.target.value });
                  }}
                  className={`${input} flex-1`}
                />
                <input
                  value={(hint.choices ?? []).join(", ")}
                  placeholder={t("flows.inspector.hintChoices")}
                  onChange={(e) => {
                    const choices = e.target.value
                      .split(",")
                      .map((choice) => choice.trim())
                      .filter((choice) => choice !== "");
                    update(index, { choices: choices.length === 0 ? undefined : choices });
                  }}
                  className={`${input} flex-1`}
                />
              </div>
              <input
                value={hint.note ?? ""}
                placeholder={t("flows.inspector.hintNote")}
                onChange={(e) => {
                  update(index, { note: e.target.value === "" ? undefined : e.target.value });
                }}
                className={`${input} mt-1`}
              />
            </div>
          ))}
          <button
            onClick={() => {
              setHints([...hints, { name: "" }]);
            }}
            className="flex items-center gap-1 self-start rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-fg"
            data-flow-add-hint
          >
            <Plus size={11} /> {t("flows.inspector.addHint")}
          </button>
        </div>
      </Field>
      <FlowSettingsFields flow={flow} onChangeFlow={onChangeFlow} />
    </>
  );
}

function FlowSettingsFields({ flow, onChangeFlow }: { flow: Flow; onChangeFlow: (flow: Flow) => void }) {
  const t = useT();
  const { settings } = flow;
  const set = (changes: Partial<Flow["settings"]>) => {
    onChangeFlow({ ...flow, settings: { ...settings, ...changes } });
  };
  return (
    <>
      <Field label={t("flows.inspector.description")}>
        <textarea
          value={flow.description}
          onChange={(e) => {
            onChangeFlow({ ...flow, description: e.target.value });
          }}
          rows={2}
          className={`${input} resize-y`}
          placeholder={t("flows.inspector.descriptionHint")}
        />
      </Field>
      <Field label={t("flows.inspector.where")} hint={t("flows.inspector.whereHint")}>
        <Segmented
          value={settings.where}
          options={[
            ["auto", t("flows.where.auto")],
            ["worktree", t("flows.where.worktree")],
            ["inPlace", t("flows.where.inPlace")],
          ]}
          onChange={(where) => {
            set({ where });
          }}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("flows.inspector.parallel")}>
          <input
            type="number"
            min={1}
            max={10}
            value={settings.parallel}
            onChange={(e) => {
              set({ parallel: Math.max(1, Math.min(10, Number(e.target.value) || 1)) });
            }}
            className={input}
          />
        </Field>
        <Field label={t("flows.inspector.costLimit")}>
          <input
            type="number"
            min={0}
            step={0.5}
            value={settings.costLimitUsd ?? ""}
            placeholder={t("flows.inspector.costNone")}
            onChange={(e) => {
              set({ costLimitUsd: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) });
            }}
            className={input}
          />
        </Field>
      </div>
    </>
  );
}

function AdvancedFields({
  step,
  parallel,
  patch,
  patchConfig,
}: {
  step: Step;
  parallel: number;
  patch: (changes: Partial<Step>) => void;
  patchConfig: (changes: Partial<StepConfig>) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line p-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("flows.inspector.retries")}>
          <input
            type="number"
            min={0}
            max={5}
            value={step.retries}
            onChange={(e) => {
              patch({ retries: Math.max(0, Math.min(5, Number(e.target.value) || 0)) });
            }}
            className={input}
          />
        </Field>
        <Field label={t("flows.inspector.timeout")}>
          <input
            type="number"
            min={0}
            value={step.timeoutMs === undefined ? "" : step.timeoutMs / 1000}
            placeholder={t("flows.inspector.timeoutNone")}
            onChange={(e) => {
              const seconds = Number(e.target.value);
              patch({ timeoutMs: e.target.value === "" || seconds <= 0 ? undefined : seconds * 1000 });
            }}
            className={input}
          />
        </Field>
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={step.forEach === true}
          onChange={(e) => {
            patch({
              forEach: e.target.checked ? true : undefined,
              onError: e.target.checked || step.onError !== "skipItems" ? step.onError : "stop",
            });
          }}
        />
        <span>{t("flows.inspector.forEach")}</span>
        <span className="text-[11px] text-muted">{t("flows.inspector.forEachHint", { n: parallel })}</span>
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={step.joinFirst === true}
          onChange={(e) => {
            patch({ joinFirst: e.target.checked ? true : undefined });
          }}
        />
        <span>{t("flows.inspector.joinFirst")}</span>
      </label>
      {step.config.ability === "ai" && (
        <>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={step.config.tools === "filesOnly"}
              onChange={(e) => {
                patchConfig({ tools: e.target.checked ? "filesOnly" : undefined });
              }}
            />
            <span>{t("flows.inspector.filesOnly")}</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={step.config.json === true}
              onChange={(e) => {
                patchConfig({ json: e.target.checked ? true : undefined });
              }}
            />
            <span>{t("flows.inspector.json")}</span>
          </label>
        </>
      )}
    </div>
  );
}

function AbilityFields({
  step,
  patchConfig,
}: {
  step: Step;
  patchConfig: (changes: Partial<StepConfig>) => void;
}) {
  const t = useT();
  const { config } = step;
  switch (config.ability) {
    case "ai":
      return <AiFields permission={config.permission} model={config.model} patchConfig={patchConfig} />;
    case "command":
      return <CommandFields command={config.command} cwd={config.cwd} patchConfig={patchConfig} />;
    case "transform":
      return (
        <Field label={t("flows.inspector.jq")} hint={t("flows.inspector.jqHint")}>
          <textarea
            value={config.program}
            onChange={(e) => {
              patchConfig({ program: e.target.value });
            }}
            rows={3}
            className={`${input} resize-y font-mono`}
          />
        </Field>
      );
    case "gate":
      return (
        <Field label={t("flows.inspector.branches")} hint={t("flows.inspector.branchesHint")}>
          <div className="flex flex-col gap-1.5">
            {config.branches.map((branch, index) => (
              <div key={index} className="flex items-center gap-1">
                <input
                  value={branch.label}
                  onChange={(e) => {
                    const branches = config.branches.map((b, i) =>
                      i === index ? { ...b, label: e.target.value } : b,
                    );
                    patchConfig({ branches });
                  }}
                  className={`${input} w-24 shrink-0`}
                />
                <input
                  value={branch.program}
                  onChange={(e) => {
                    const branches = config.branches.map((b, i) =>
                      i === index ? { ...b, program: e.target.value } : b,
                    );
                    patchConfig({ branches });
                  }}
                  className={`${input} font-mono`}
                />
                <button
                  onClick={() => {
                    patchConfig({
                      branches: config.branches.filter((_, i) => i !== index),
                    });
                  }}
                  className="shrink-0 rounded p-1 text-muted hover:text-danger"
                  title={t("flows.inspector.remove")}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <button
              onClick={() => {
                patchConfig({
                  branches: [
                    ...config.branches,
                    { label: `branch-${String(config.branches.length + 1)}`, program: "false" },
                  ],
                });
              }}
              className="flex items-center gap-1 self-start rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-fg"
            >
              <Plus size={11} /> {t("flows.inspector.addBranch")}
            </button>
          </div>
        </Field>
      );
    case "wait":
      return (
        <Field
          label={t("flows.inspector.seconds")}
          hint={t("flows.inspector.secondsHint", { max: MAX_WAIT_SECONDS })}
        >
          <input
            type="number"
            min={1}
            max={MAX_WAIT_SECONDS}
            value={config.seconds}
            onChange={(e) => {
              patchConfig({ seconds: Number(e.target.value) || 1 });
            }}
            className={input}
          />
        </Field>
      );
    case "human":
      return (
        <>
          <Field label={t("flows.inspector.humanMode")}>
            <Segmented
              value={config.mode}
              options={[
                ["approve", t("flows.human.approve")],
                ["choose", t("flows.human.choose")],
                ["edit", t("flows.human.edit")],
                ["form", t("flows.human.form")],
              ]}
              onChange={(mode) => {
                patchConfig({ mode });
              }}
            />
          </Field>
          {config.mode === "choose" && (
            <Field label={t("flows.inspector.options")} hint={t("flows.inspector.optionsHint")}>
              <textarea
                value={(config.options ?? []).join("\n")}
                onChange={(e) => {
                  patchConfig({
                    options: e.target.value.split("\n").filter((line) => line.trim() !== ""),
                  });
                }}
                rows={3}
                className={`${input} resize-y`}
              />
            </Field>
          )}
          {config.mode === "form" && (
            <Field label={t("flows.inspector.fields")} hint={t("flows.inspector.fieldsHint")}>
              <textarea
                value={(config.fields ?? []).map((field) => field.name).join("\n")}
                onChange={(e) => {
                  patchConfig({
                    fields: e.target.value
                      .split("\n")
                      .filter((line) => line.trim() !== "")
                      .map((name) => ({ name })),
                  });
                }}
                rows={3}
                className={`${input} resize-y`}
              />
            </Field>
          )}
        </>
      );
    case "http":
      return <HttpFields config={config} patchConfig={patchConfig} />;
    case "service":
      return <ServiceFields config={config} patchConfig={patchConfig} />;
    case "git":
      return <GitFields config={config} patchConfig={patchConfig} />;
    case "mail":
      return (
        <MailFields
          connection={config.connection}
          to={config.to}
          subject={config.subject}
          body={config.body}
          patchConfig={patchConfig}
        />
      );
    case "files":
      return (
        <Field label={t("flows.inspector.globs")} hint={t("flows.inspector.globsHint")}>
          <textarea
            value={config.globs.join("\n")}
            onChange={(e) => {
              patchConfig({
                globs: e.target.value
                  .split("\n")
                  .map((glob) => glob.trim())
                  .filter((glob) => glob !== ""),
              });
            }}
            rows={3}
            className={`${input} resize-y font-mono`}
          />
        </Field>
      );
    case "subflow":
      return <SubflowFields slug={config.slug} text={config.text} patchConfig={patchConfig} />;
    case "free":
      return (
        <p className="rounded-md bg-elevated px-2 py-1.5 text-[11px] text-muted">
          {t("flows.inspector.freeHint")}
        </p>
      );
    default:
      return null;
  }
}

function AiFields({
  permission,
  model,
  patchConfig,
}: {
  permission: Permission;
  model?: string;
  patchConfig: (changes: Partial<StepConfig>) => void;
}) {
  const t = useT();
  const providerId = useAi((s) => s.providerId);
  const catalog = useAi((s) => s.modelCatalog);
  const models = modelsOf(providerId, catalog[providerId]);
  return (
    <>
      <Field label={t("flows.inspector.model")}>
        <select
          value={model ?? ""}
          onChange={(e) => {
            patchConfig({ model: e.target.value === "" ? undefined : e.target.value });
          }}
          className={input}
        >
          <option value="">{t("flows.inspector.modelAuto")}</option>
          {models.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("flows.inspector.permission")} hint={t("flows.inspector.permissionHint")}>
        <Segmented
          value={permission}
          options={[
            ["readOnly", t("flows.permission.readOnly")],
            ["edits", t("flows.permission.edits")],
            ["full", t("flows.permission.full")],
          ]}
          onChange={(value) => {
            patchConfig({ permission: value });
          }}
        />
      </Field>
    </>
  );
}

function CommandFields({
  command,
  cwd,
  patchConfig,
}: {
  command: PlatformCommand;
  cwd?: string;
  patchConfig: (changes: Partial<StepConfig>) => void;
}) {
  const t = useT();
  const tasks = useTasks((s) => s.tasks);
  return (
    <>
      {tasks.length > 0 && (
        <Field label={t("flows.inspector.fromTasks")} hint={t("flows.inspector.fromTasksHint")}>
          <select
            value=""
            onChange={(e) => {
              const task = tasks.find((candidate) => candidate.id === e.target.value);
              if (task === undefined) return;
              const [program = "", ...args] = tokenize(task.command);
              patchConfig({
                command: { ...command, all: [{ program, args }] },
                cwd: task.cwd,
              });
            }}
            className={input}
          >
            <option value="">{t("flows.inspector.pickTask")}</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.label} · {task.command}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label={t("flows.inspector.commandAll")} hint={t("flows.inspector.commandAllHint")}>
        <InvocationList
          invocations={command.all ?? []}
          onChange={(all) => {
            patchConfig({ command: { ...command, all } });
          }}
        />
      </Field>
      {(["windows", "macos", "linux"] as const).map((platform) => (
        <Field key={platform} label={t(`flows.inspector.arm.${platform}`)}>
          <input
            value={command[platform] ?? ""}
            placeholder={t("flows.inspector.armNone")}
            onChange={(e) => {
              patchConfig({
                command: { ...command, [platform]: e.target.value === "" ? undefined : e.target.value },
              });
            }}
            className={`${input} font-mono`}
          />
        </Field>
      ))}
      <Field label={t("flows.inspector.cwd")}>
        <input
          value={cwd ?? ""}
          placeholder="."
          onChange={(e) => {
            patchConfig({ cwd: e.target.value === "" ? undefined : e.target.value });
          }}
          className={`${input} font-mono`}
        />
      </Field>
    </>
  );
}

function HttpFields({
  config,
  patchConfig,
}: {
  config: HttpConfig;
  patchConfig: (changes: Partial<StepConfig>) => void;
}) {
  const t = useT();
  const headers = Object.entries(config.headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
  return (
    <>
      <div className="grid grid-cols-[96px_1fr] gap-2">
        <Field label={t("flows.inspector.method")}>
          <select
            value={config.method}
            onChange={(e) => {
              patchConfig({ method: e.target.value } as Partial<StepConfig>);
            }}
            className={input}
          >
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </Field>
        <Field label="URL">
          <input
            value={config.url}
            onChange={(e) => {
              patchConfig({ url: e.target.value });
            }}
            className={`${input} font-mono`}
          />
        </Field>
      </div>
      <Field label={t("flows.inspector.headers")} hint={t("flows.inspector.headersHint")}>
        <textarea
          value={headers}
          onChange={(e) => {
            const next: Record<string, string> = {};
            for (const line of e.target.value.split("\n")) {
              const at = line.indexOf(":");
              if (at > 0) next[line.slice(0, at).trim()] = line.slice(at + 1).trim();
            }
            patchConfig({ headers: next });
          }}
          rows={3}
          className={`${input} resize-y font-mono`}
          placeholder="Authorization: Bearer {{secret.github}}"
        />
      </Field>
      {config.method !== "GET" && (
        <Field label={t("flows.inspector.body")}>
          <textarea
            value={config.body ?? ""}
            onChange={(e) => {
              patchConfig({
                body: e.target.value === "" ? undefined : e.target.value,
              });
            }}
            rows={4}
            className={`${input} resize-y font-mono`}
          />
        </Field>
      )}
      <Field label={t("flows.inspector.parse")}>
        <Segmented
          value={config.parse ?? "json"}
          options={[
            ["json", "JSON"],
            ["text", t("flows.inspector.parseText")],
          ]}
          onChange={(parse) => {
            patchConfig({ parse });
          }}
        />
      </Field>
    </>
  );
}

function ServiceFields({
  config,
  patchConfig,
}: {
  config: ServiceConfig;
  patchConfig: (changes: Partial<StepConfig>) => void;
}) {
  const t = useT();
  const setDoor = (next: ServiceConfig["door"]) => {
    const fresh: ServiceConfig =
      next === "tracker"
        ? { door: "tracker", action: "detail" }
        : next === "mcp"
          ? { door: "mcp", server: "" }
          : { door: "cli", command: { all: [] } };
    // Every field of the old door goes, so a config never carries two doors' worth.
    const cleared = Object.fromEntries(Object.keys(config).map((key) => [key, undefined]));
    patchConfig({ ...cleared, ...fresh });
  };
  return (
    <>
      <Field label={t("flows.inspector.door")} hint={t("flows.inspector.doorHint")}>
        <Segmented
          value={config.door}
          options={[
            ["tracker", t("flows.door.tracker")],
            ["mcp", t("flows.door.mcp")],
            ["cli", t("flows.door.cli")],
          ]}
          onChange={setDoor}
        />
      </Field>
      {config.door === "tracker" && (
        <>
          <Field label={t("flows.inspector.action")}>
            <Segmented
              value={config.action}
              options={[
                ["list", t("flows.tracker.list")],
                ["detail", t("flows.tracker.detail")],
                ["comment", t("flows.tracker.comment")],
                ["setState", t("flows.tracker.setState")],
              ]}
              onChange={(action) => {
                patchConfig({ action });
              }}
            />
          </Field>
          {config.action !== "list" && (
            <Field label={t("flows.inspector.itemId")} hint={t("flows.inspector.itemIdHint")}>
              <input
                value={config.itemId ?? ""}
                placeholder="{{input.items.0.ref}}"
                onChange={(e) => {
                  patchConfig({
                    itemId: e.target.value === "" ? undefined : e.target.value,
                  });
                }}
                className={`${input} font-mono`}
              />
            </Field>
          )}
          {config.action === "comment" && (
            <Field label={t("flows.inspector.commentText")}>
              <textarea
                value={config.text ?? ""}
                onChange={(e) => {
                  patchConfig({ text: e.target.value });
                }}
                rows={3}
                className={`${input} resize-y`}
              />
            </Field>
          )}
          {config.action === "setState" && (
            <Field label={t("flows.inspector.state")}>
              <input
                value={config.state ?? ""}
                onChange={(e) => {
                  patchConfig({ state: e.target.value });
                }}
                className={input}
              />
            </Field>
          )}
        </>
      )}
      {config.door === "mcp" && (
        <>
          <Field label={t("flows.inspector.mcpServer")} hint={t("flows.inspector.mcpServerHint")}>
            <input
              value={config.server}
              onChange={(e) => {
                patchConfig({ server: e.target.value });
              }}
              className={input}
            />
          </Field>
          <Field label={t("flows.inspector.permission")}>
            <Segmented
              value={config.permission ?? "readOnly"}
              options={[
                ["readOnly", t("flows.permission.readOnly")],
                ["edits", t("flows.permission.edits")],
                ["full", t("flows.permission.full")],
              ]}
              onChange={(permission) => {
                patchConfig({ permission });
              }}
            />
          </Field>
        </>
      )}
      {config.door === "cli" && (
        <CommandFields command={config.command} cwd={config.cwd} patchConfig={patchConfig} />
      )}
    </>
  );
}

function GitFields({
  config,
  patchConfig,
}: {
  config: GitConfig;
  patchConfig: (changes: Partial<StepConfig>) => void;
}) {
  const t = useT();
  return (
    <>
      <Field label={t("flows.inspector.action")}>
        <select
          value={config.action}
          onChange={(e) => {
            patchConfig({ action: e.target.value } as Partial<StepConfig>);
          }}
          className={input}
        >
          {(["diff", "log", "branch", "commit", "push", "pr"] as const).map((action) => (
            <option key={action} value={action}>
              {t(`flows.git.${action}`)}
            </option>
          ))}
        </select>
      </Field>
      {config.action === "branch" && (
        <Field label={t("flows.inspector.branch")}>
          <input
            value={config.branch ?? ""}
            onChange={(e) => {
              patchConfig({ branch: e.target.value });
            }}
            className={`${input} font-mono`}
          />
        </Field>
      )}
      {config.action === "commit" && (
        <Field label={t("flows.inspector.message")}>
          <textarea
            value={config.message ?? ""}
            onChange={(e) => {
              patchConfig({ message: e.target.value });
            }}
            rows={2}
            className={`${input} resize-y`}
          />
        </Field>
      )}
      {config.action === "log" && (
        <Field label={t("flows.inspector.count")}>
          <input
            type="number"
            min={1}
            max={500}
            value={config.count ?? 20}
            onChange={(e) => {
              patchConfig({ count: Number(e.target.value) || 20 });
            }}
            className={input}
          />
        </Field>
      )}
      {config.action === "pr" && (
        <>
          <Field label={t("flows.inspector.prTitle")}>
            <input
              value={config.title ?? ""}
              onChange={(e) => {
                patchConfig({ title: e.target.value });
              }}
              className={input}
            />
          </Field>
          <Field label={t("flows.inspector.prBody")}>
            <textarea
              value={config.body ?? ""}
              onChange={(e) => {
                patchConfig({ body: e.target.value });
              }}
              rows={3}
              className={`${input} resize-y`}
            />
          </Field>
          <Field label={t("flows.inspector.prBase")}>
            <input
              value={config.base ?? "main"}
              onChange={(e) => {
                patchConfig({ base: e.target.value });
              }}
              className={`${input} font-mono`}
            />
          </Field>
          <p className="text-[10.5px] text-muted">{t("flows.inspector.prNeedsGh")}</p>
        </>
      )}
    </>
  );
}

function MailFields({
  connection,
  to,
  subject,
  body,
  patchConfig,
}: {
  connection: string;
  to: string[];
  subject: string;
  body: string;
  patchConfig: (changes: Partial<StepConfig>) => void;
}) {
  const t = useT();
  const secrets = useFlows((s) => s.secretNames);
  const accounts = secrets.filter((name) => name.startsWith("mail.")).map((name) => name.slice(5));
  return (
    <>
      <Field
        label={t("flows.inspector.mailConnection")}
        hint={accounts.length === 0 ? t("flows.inspector.mailNone") : undefined}
      >
        <select
          value={connection}
          onChange={(e) => {
            patchConfig({ connection: e.target.value });
          }}
          className={input}
        >
          <option value="">{t("flows.inspector.pick")}</option>
          {accounts.map((account) => (
            <option key={account} value={account}>
              {account}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("flows.inspector.mailTo")} hint={t("flows.inspector.mailToHint")}>
        <input
          value={to.join(", ")}
          onChange={(e) => {
            patchConfig({
              to: e.target.value
                .split(",")
                .map((address) => address.trim())
                .filter((address) => address !== ""),
            });
          }}
          className={input}
        />
      </Field>
      <Field label={t("flows.inspector.mailSubject")}>
        <input
          value={subject}
          onChange={(e) => {
            patchConfig({ subject: e.target.value });
          }}
          className={input}
        />
      </Field>
      <Field label={t("flows.inspector.mailBody")}>
        <textarea
          value={body}
          onChange={(e) => {
            patchConfig({ body: e.target.value });
          }}
          rows={5}
          className={`${input} resize-y`}
        />
      </Field>
    </>
  );
}

function SubflowFields({
  slug,
  text,
  patchConfig,
}: {
  slug: string;
  text?: string;
  patchConfig: (changes: Partial<StepConfig>) => void;
}) {
  const t = useT();
  const flows = useFlows((s) => s.flows);
  return (
    <>
      <Field label={t("flows.inspector.subflow")}>
        <select
          value={slug}
          onChange={(e) => {
            patchConfig({ slug: e.target.value });
          }}
          className={input}
        >
          <option value="">{t("flows.inspector.pick")}</option>
          {flows.map((stored) => (
            <option key={stored.slug} value={stored.slug}>
              {stored.flow.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("flows.inspector.subflowText")} hint={t("flows.inspector.subflowTextHint")}>
        <textarea
          value={text ?? ""}
          onChange={(e) => {
            patchConfig({ text: e.target.value === "" ? undefined : e.target.value });
          }}
          rows={2}
          className={`${input} resize-y`}
        />
      </Field>
    </>
  );
}

function InvocationList({
  invocations,
  onChange,
}: {
  invocations: Invocation[];
  onChange: (invocations: Invocation[]) => void;
}) {
  const t = useT();
  const [text, setText] = useState(() =>
    invocations.map((invocation) => [invocation.program, ...invocation.args].join(" ")).join("\n"),
  );
  return (
    <textarea
      value={text}
      placeholder={t("flows.inspector.commandAllPlaceholder")}
      onChange={(e) => {
        setText(e.target.value);
        onChange(
          e.target.value
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => {
              const [program = "", ...args] = tokenize(line);
              return { program, args };
            }),
        );
      }}
      rows={3}
      className={`${input} resize-y font-mono`}
    />
  );
}

/** Words of a command line, with double quotes keeping a word together - no shell beyond that. */
export function tokenize(line: string): string[] {
  const words: string[] = [];
  for (const match of line.matchAll(/"([^"]*)"|(\S+)/g)) {
    const quoted = match[1] as string | undefined;
    const bare = match[2] as string | undefined;
    words.push(quoted ?? bare ?? "");
  }
  return words;
}
