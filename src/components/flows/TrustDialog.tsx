import { ShieldAlert, X } from "lucide-react";
import { useT } from "../../i18n";
import { reachesOf, type Flow } from "../../lib/flows/model";

/**
 * A flow that arrived through git, and was not written on this machine, can
 * run commands and call hosts. Its first run shows what it will do - every
 * command, every host, every connection - and asks once; any change to those
 * parts asks again (the trust record is of the flow's content).
 */
export function TrustDialog({
  flow,
  onTrust,
  onClose,
}: {
  flow: Flow;
  onTrust: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const reaches = reachesOf(flow);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-20" onClick={onClose}>
      <div
        role="dialog"
        aria-label={t("flows.trust.title", { name: flow.name })}
        className="w-[520px] max-w-[92vw] rounded-xl border border-warn/50 bg-panel shadow-2xl"
        onClick={(e) => {
          e.stopPropagation();
        }}
        data-flows-trust
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <ShieldAlert size={14} className="text-warn" />
          <span className="flex-1 text-[13px] font-semibold">
            {t("flows.trust.title", { name: flow.name })}
          </span>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-elevated hover:text-fg">
            <X size={14} />
          </button>
        </div>
        <div className="flex flex-col gap-3 px-4 py-3 text-[12px]">
          <p className="text-muted">{t("flows.trust.explain")}</p>
          <List title={t("flows.trust.commands")} items={reaches.commands} none={t("flows.trust.none")} />
          <List title={t("flows.trust.hosts")} items={reaches.hosts} none={t("flows.trust.none")} />
          <List title={t("flows.trust.secrets")} items={reaches.secrets} none={t("flows.trust.none")} />
        </div>
        <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
          <span className="flex-1 text-[11px] text-muted">{t("flows.trust.again")}</span>
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-muted hover:bg-elevated hover:text-fg"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={onTrust}
            className="rounded px-3 py-1.5 font-medium text-white bg-accent-strong hover:opacity-90"
            data-flows-trust-run
          >
            {t("flows.trust.run")}
          </button>
        </div>
      </div>
    </div>
  );
}

function List({ title, items, none }: { title: string; items: string[]; none: string }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">{title}</p>
      {items.length === 0 ? (
        <p className="text-[11.5px] text-muted/70">{none}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {items.map((item) => (
            <li key={item} className="rounded bg-elevated px-2 py-0.5 font-mono text-[11px]">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
