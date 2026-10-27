import { useState } from "react";
import { BookOpen, ChevronUp, Copy, Trash2 } from "lucide-react";
import { useT } from "../../i18n";
import type { TranslationKey } from "../../i18n/en";
import type { Ability, Step } from "../../lib/flows/model";
import { shortcutLabel } from "../../lib/shortcuts";
import { abilityOf } from "./abilities";

/** Where the open-or-closed choice for the step guide is kept, per person. */
const GUIDE_KEY = "aime.flows.stepGuide";

/**
 * Whether the guide at the top of a step's settings is open: open until the
 * person closes it, and kept closed from then on - a guide that has been read
 * should stop taking the room.
 */
export function useStepGuideOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(GUIDE_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const choose = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(GUIDE_KEY, next ? "open" : "closed");
    } catch (error: unknown) {
      console.warn("the step guide's state could not be kept:", error);
    }
  };
  return [open, choose];
}

/** What wiring means for this kind of step: the input has no way in, a condition one way out per branch. */
function portsNote(ability: Ability): TranslationKey {
  if (ability === "input") return "flows.howto.portsInput";
  if (ability === "gate") return "flows.howto.portsGate";
  return "flows.howto.ports";
}

/** How to use the picked step: what it does, the steps to set it up, how it is wired. */
export function StepGuide({ step, onClose }: { step: Step; onClose: () => void }) {
  const t = useT();
  const look = abilityOf(step);
  const how = t(`flows.howto.${step.config.ability}`).split("\n");
  return (
    <section
      className="border-b border-line bg-accent-soft/40 px-3 py-2.5 text-[11.5px] leading-relaxed"
      data-flow-help-text
      data-flow-guide={step.config.ability}
    >
      <div className="mb-1 flex items-center gap-1.5 font-semibold text-accent">
        <BookOpen size={12} />
        <span className="flex-1">{t("flows.guide.title", { kind: t(look.label) })}</span>
        <button
          onClick={onClose}
          title={t("flows.guide.hide")}
          className="rounded p-0.5 text-muted hover:bg-elevated hover:text-fg"
        >
          <ChevronUp size={13} />
        </button>
      </div>
      <p className="whitespace-pre-wrap">{t(look.help)}</p>
      <ol className="mt-1.5 list-decimal space-y-0.5 pl-4">
        {how.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
      <p className="mt-1.5 text-muted">{t(portsNote(step.config.ability))}</p>
    </section>
  );
}

/** The inspector with nothing picked: how a flow is built, and the keys that do it. */
export function DesignerGuide() {
  const t = useT();
  const keys: [string, TranslationKey][] = [
    [t("flows.keys.drag"), "flows.keys.dragDoes"],
    [t("flows.keys.dropOnWire"), "flows.keys.dropOnWireDoes"],
    [t("flows.keys.portToEmpty"), "flows.keys.portToEmptyDoes"],
    [t("flows.keys.rightClick"), "flows.keys.rightClickDoes"],
    [t("flows.keys.box"), "flows.keys.boxDoes"],
    [t("flows.keys.pan"), "flows.keys.panDoes"],
    ["Del", "flows.keys.deleteDoes"],
    [`${shortcutLabel("Z")} / ${shortcutLabel("Y")}`, "flows.keys.undoDoes"],
    [shortcutLabel("D"), "flows.keys.duplicateDoes"],
    [`${shortcutLabel("C")} / ${shortcutLabel("V")}`, "flows.keys.copyDoes"],
    [shortcutLabel("A"), "flows.keys.allDoes"],
  ];
  return (
    <div className="flex flex-col gap-3 px-3 py-3 text-[12px]" data-flow-designer-guide>
      <div>
        <h4 className="mb-1 flex items-center gap-1.5 font-semibold text-accent">
          <BookOpen size={13} /> {t("flows.guide.buildTitle")}
        </h4>
        <ol className="list-decimal space-y-1 pl-4 text-[11.5px] leading-relaxed">
          {t("flows.guide.build")
            .split("\n")
            .map((line) => (
              <li key={line}>{line}</li>
            ))}
        </ol>
      </div>
      <div>
        <h4 className="mb-1 text-[10.5px] font-semibold tracking-wider text-muted uppercase">
          {t("flows.guide.keysTitle")}
        </h4>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
          {keys.map(([key, does]) => (
            <div key={does} className="contents">
              <dt>
                <kbd className="rounded border border-line bg-elevated px-1 py-px font-sans text-[10.5px]">
                  {key}
                </kbd>
              </dt>
              <dd className="text-muted">{t(does)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** The inspector with several steps picked: what can be done to them together. */
export function SelectionPanel({
  count,
  onDuplicate,
  onDelete,
}: {
  count: number;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const button =
    "flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[11.5px] text-muted hover:border-accent hover:text-fg";
  return (
    <div className="flex flex-col gap-2 px-3 py-3 text-[12px]" data-flow-selection={count}>
      <p className="font-semibold">{t("flows.selection.title", { n: count })}</p>
      <p className="text-[11.5px] text-muted">{t("flows.selection.hint")}</p>
      <div className="flex gap-2">
        <button onClick={onDuplicate} className={button}>
          <Copy size={12} /> {t("flows.menu.duplicate")}
          <kbd className="font-sans text-[10.5px]">{shortcutLabel("D")}</kbd>
        </button>
        <button onClick={onDelete} className={`${button} hover:border-danger hover:text-danger`}>
          <Trash2 size={12} /> {t("flows.menu.delete")}
        </button>
      </div>
    </div>
  );
}
