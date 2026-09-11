import { useState } from "react";
import { Check, Cloud, X } from "lucide-react";
import { useT } from "../i18n";
import { useCloud, type CloudStatus } from "../stores/cloud";
import { CloudDot, cloudStateText } from "./CloudDot";

/**
 * Which clouds get a tab.
 *
 * Requested 2026-09-09: the panel opened with a tab for all four vendors, and
 * most people use one or two - the rest is somebody else's cloud taking up the
 * strip. So the first time the panel is opened this asks, the answer is
 * remembered for the machine, and it can be reopened from the strip at any
 * time to bring a cloud back.
 *
 * Ticking a cloud is only about the tab. Nothing is signed out, nothing is
 * forgotten: what was read from a cloud that leaves stays cached, so bringing
 * it back costs no call into anybody's cloud.
 */
export function CloudPicker({ clouds, shown }: { clouds: CloudStatus[]; shown: string[] | null }) {
  const chooseClouds = useCloud((s) => s.chooseClouds);
  const closePicker = useCloud((s) => s.closePicker);
  // Starts as the panel stands - the gesture asked for is untick what you do
  // not use, not build the list again from nothing.
  const [picked, setPicked] = useState<string[]>(() =>
    shown === null ? clouds.map((cloud) => cloud.id) : shown,
  );
  const t = useT();

  const toggle = (id: string) => {
    setPicked((current) => (current.includes(id) ? current.filter((kept) => kept !== id) : [...current, id]));
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 pt-16"
      onClick={closePicker}
    >
      <div
        role="dialog"
        aria-modal
        aria-label={t("cloud.pickTitle")}
        className="flex w-[420px] max-w-[92vw] flex-col rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Cloud size={15} className="shrink-0 text-accent" />
          <span className="flex-1 text-xs font-semibold">{t("cloud.pickTitle")}</span>
          <button
            onClick={closePicker}
            title={t("cloud.close")}
            className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>

        <p className="px-4 pt-3 text-[11.5px] text-muted">{t("cloud.pickHint")}</p>

        <div className="flex flex-col gap-1 p-3">
          {clouds.map((cloud) => {
            const on = picked.includes(cloud.id);
            return (
              <label
                key={cloud.id}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-elevated"
              >
                <span
                  className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                    on ? "border-accent bg-accent text-bg" : "border-line"
                  }`}
                >
                  {on && <Check size={11} strokeWidth={3} />}
                </span>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    toggle(cloud.id);
                  }}
                  className="sr-only"
                />
                <CloudDot cloud={cloud} />
                <span className="text-[12px]">{cloud.label}</span>
                <span className="flex-1" />
                <span className="max-w-52 truncate text-[11px] text-muted">{cloudStateText(cloud, t)}</span>
              </label>
            );
          })}
        </div>

        <div className="flex items-center gap-2 border-t border-line px-4 py-2 text-[11.5px]">
          <button
            onClick={() => {
              setPicked(clouds.map((cloud) => cloud.id));
            }}
            className="text-muted hover:text-fg"
          >
            {t("cloud.pickAll")}
          </button>
          <span className="flex-1" />
          <button
            disabled={picked.length === 0}
            onClick={() => {
              chooseClouds(clouds.flatMap((cloud) => (picked.includes(cloud.id) ? [cloud.id] : [])));
            }}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-40"
          >
            {t("cloud.pickDone", { count: picked.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
