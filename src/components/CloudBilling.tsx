import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CreditCard, ExternalLink, Loader2 } from "lucide-react";
import { useT } from "../i18n";
import type { BillingOff } from "../lib/cloudErrors";
import { runInTerminal } from "../stores/terminals";

/** A billing account `gcloud` can see, as `cloud/gcp.rs` answers it. */
interface BillingAccount {
  id: string;
  label: string;
  open: boolean;
}

/** Google's own page for billing, the only place an account can be opened. */
const BILLING_PAGE = "https://console.cloud.google.com/billing";

/**
 * The one command that fixes a project with no billing account.
 *
 * Exported so a test can hold the exact line, and so the button can show it:
 * a write to somebody's cloud is never run behind a label.
 */
export function linkCommand(project: string, billingAccount: string): string {
  return `gcloud billing projects link ${project} --billing-account ${billingAccount}`;
}

/**
 * What the panel shows when Google Cloud refuses for want of a billing account.
 *
 * Measured 2026-09-10 on a real deploy: the first step, `gcloud services
 * enable`, answered *Billing account for project '130881371924' is not found*,
 * and the run stopped with "The AI could not say how to go on" - true, and
 * useless. No retry, no sign-in and no rewritten command gets past this; there
 * are exactly two ways on, and which one applies is decided by asking the CLI
 * rather than by guessing:
 *
 * - an OPEN billing account exists → one command links it, run in a terminal
 *   tab like every other write this panel makes;
 * - none does → only Google's page can open one (`gcloud billing accounts` has
 *   no `create`), and saying so is more use than a button that cannot work.
 */
export function BillingOffNote({ off, project }: { off: BillingOff; project: string }) {
  const t = useT();
  const [accounts, setAccounts] = useState<BillingAccount[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    invoke<BillingAccount[]>("cloud_billing_accounts", { cloudId: "gcp" })
      .then((found) => {
        if (live) setAccounts(found);
      })
      .catch(() => {
        // The panel still explains the wall; it just cannot offer the shortcut.
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const usable = accounts?.filter((account) => account.open) ?? [];
  const closed = (accounts?.length ?? 0) - usable.length;

  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-2">
      <p className="text-center text-[11.5px] text-muted">
        {t("cloud.billingOff", { project })}
        {off.services.length > 0 && ` ${t("cloud.billingBlocked", { count: off.services.length })}`}
      </p>
      {accounts === null && !failed && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted">
          <Loader2 size={11} className="animate-spin" /> {t("cloud.billingLooking")}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {usable.map((account) => {
          const command = linkCommand(project, account.id);
          return (
            <button
              key={account.id}
              onClick={() => {
                runInTerminal(command, t("cloud.billingLinking", { account: account.label }));
              }}
              title={command}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 font-medium text-bg"
            >
              <CreditCard size={12} /> {t("cloud.billingLink", { account: account.label })}
            </button>
          );
        })}
        <button
          onClick={() => void openUrl(BILLING_PAGE)}
          className="flex items-center gap-1.5 rounded border border-line px-3 py-1.5 text-muted hover:border-accent hover:text-fg"
        >
          <ExternalLink size={11} /> {t("cloud.billingOpenPage")}
        </button>
      </div>
      {accounts !== null && usable.length === 0 && (
        <p className="max-w-xl text-center text-[11px] text-muted">
          {closed > 0 ? t("cloud.billingAllClosed", { count: closed }) : t("cloud.billingNone")}
        </p>
      )}
    </div>
  );
}
