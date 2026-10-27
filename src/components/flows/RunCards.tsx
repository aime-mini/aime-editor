import { useState } from "react";
import { UserRound } from "lucide-react";
import { useT } from "../../i18n";
import type { Ask } from "../../lib/flows/engine";
import { useFlows } from "../../stores/flows";
import { Markdown } from "../Markdown";

/**
 * What a run needs from the person, laid over the top of its canvas where the
 * eye already is: a step's question, or the cost limit it reached.
 */

/** A person's turn: approve, choose, edit, or fill in what the step asks. */
export function AskCard({
  runId,
  ask,
  stepName,
  root,
}: {
  runId: string;
  ask: Ask;
  stepName: string;
  /** Where the run works: the files the question names open from there. */
  root: string;
}) {
  const t = useT();
  const answer = useFlows((s) => s.answer);
  const [note, setNote] = useState("");
  const [edited, setEdited] = useState(() => textOf(ask.input));
  const [form, setForm] = useState<Record<string, string>>({});
  const reply = (value: unknown) => {
    answer(runId, value);
  };
  return (
    <div className={`${card} border-pink-400/60`} data-flow-ask={ask.mode}>
      <p className="flex items-center gap-1.5 font-semibold text-pink-400">
        <UserRound size={13} /> {stepName}
      </p>
      {ask.prompt.trim() !== "" && (
        // A question can carry a whole analysis: it scrolls inside the card, and
        // the files it names - a design, its mockups - open from it.
        <div className="mt-1 max-h-[40vh] overflow-y-auto pr-1" data-flow-ask-prompt>
          <Markdown text={ask.prompt} root={root} />
        </div>
      )}
      {ask.mode === "approve" && (
        <>
          <textarea
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
            }}
            placeholder={t("flows.ask.note")}
            rows={2}
            className={area}
          />
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => {
                reply({ approved: true, note });
              }}
              className={primary}
              data-flow-approve
            >
              {t("flows.ask.approve")}
            </button>
            <button
              onClick={() => {
                reply({ approved: false, note: note || t("flows.ask.declined") });
              }}
              className={ghost}
              data-flow-decline
            >
              {t("flows.ask.decline")}
            </button>
          </div>
        </>
      )}
      {ask.mode === "choose" && (
        <div className="mt-2 flex flex-col gap-1">
          {(ask.options ?? []).map((option) => (
            <button
              key={option}
              onClick={() => {
                reply(option);
              }}
              className={`${ghost} justify-start`}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      {ask.mode === "edit" && (
        <>
          <textarea
            value={edited}
            onChange={(e) => {
              setEdited(e.target.value);
            }}
            rows={8}
            className={`${area} font-mono`}
          />
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => {
                reply(edited);
              }}
              className={primary}
            >
              {t("flows.ask.useThis")}
            </button>
          </div>
        </>
      )}
      {ask.mode === "form" && (
        <>
          {(ask.fields ?? []).map((field) => (
            <label key={field.name} className="mt-2 flex flex-col gap-1">
              <span className="text-[11px] text-muted">{field.name}</span>
              <input
                value={form[field.name] ?? ""}
                onChange={(e) => {
                  setForm({ ...form, [field.name]: e.target.value });
                }}
                className="rounded border border-line bg-elevated px-2 py-1 outline-none focus:border-accent"
              />
            </label>
          ))}
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => {
                reply(form);
              }}
              className={primary}
            >
              {t("flows.ask.submit")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** The run reached its cost limit and waits to be told whether to go on. */
export function CostCard({ runId, costUsd, limitUsd }: { runId: string; costUsd: number; limitUsd: number }) {
  const t = useT();
  const go = useFlows((s) => s.continueAfterCost);
  return (
    <div className={`${card} border-warn/60`} data-flow-cost-paused>
      <p className="font-semibold text-warn">{t("flows.cost.title")}</p>
      <p className="mt-1 text-muted">
        {t("flows.cost.body", { spent: costUsd.toFixed(2), limit: limitUsd.toFixed(2) })}
      </p>
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => {
            go(runId, true);
          }}
          className={primary}
        >
          {t("flows.cost.goOn")}
        </button>
        <button
          onClick={() => {
            go(runId, false);
          }}
          className={ghost}
        >
          {t("flows.run.stop")}
        </button>
      </div>
    </div>
  );
}

/** What an edit card starts with: the one upstream value, as text. */
function textOf(input: Ask["input"]): string {
  const values = Object.values(input).map((output) => output.value);
  const one = values.length === 1 ? values[0] : values;
  return typeof one === "string" ? one : JSON.stringify(one, null, 2);
}

const card = "w-[min(440px,100%)] rounded-lg border bg-panel p-3 text-[12px] shadow-xl";
const area =
  "mt-2 w-full resize-y rounded border border-line bg-elevated px-2 py-1 text-[12px] outline-none focus:border-accent";
const primary =
  "flex items-center gap-1 rounded px-3 py-1.5 font-medium text-white bg-accent-strong hover:opacity-90";
const ghost =
  "flex items-center rounded border border-line px-3 py-1.5 text-muted hover:border-accent hover:text-fg";
