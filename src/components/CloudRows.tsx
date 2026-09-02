import { useEffect, useState } from "react";
import { Check, Cloud, Copy, Loader2, Radar, TriangleAlert } from "lucide-react";
import { useT } from "../i18n";
import { useCloud, type CloudStatus } from "../stores/cloud";
import { useWorkspace } from "../stores/workspace";

/**
 * The clouds this project can reach, one row each.
 *
 * Three states, and each one offers exactly the next thing to do: no CLI shows
 * the command that installs it, a CLI nobody has signed into shows the command
 * that signs in, and a signed-in cloud offers to go and find out what is
 * already running in it.
 *
 * Signing in is a copyable command rather than a button, and deliberately so:
 * `az login` opens a browser and waits for a person, so a button that ran it
 * silently in the background would be a button that appeared to do nothing.
 * Aime never takes the credential itself - the vendor's CLI owns its own
 * sign-in, and Aime reads only who it says it is.
 */
export function CloudRows() {
  const { clouds, ready, discovering, result, refresh, discover } = useCloud();
  const rootPath = useWorkspace((s) => s.rootPath);
  const t = useT();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!ready) {
    return (
      <p className="flex items-center gap-1.5 py-1 text-[11px] text-muted">
        <Loader2 size={11} className="animate-spin" /> {t("cloud.looking")}
      </p>
    );
  }

  return (
    <>
      {clouds.map((cloud) => (
        <CloudRow
          key={cloud.id}
          cloud={cloud}
          busy={discovering === cloud.id}
          // One at a time: two discoveries would race for the same section of
          // the same memory file, and the loser's findings would vanish.
          disabled={discovering !== null || rootPath === null}
          hint={rootPath === null ? t("cloud.needsProject") : ""}
          onDiscover={() => void discover(cloud.id)}
        />
      ))}
      {result !== null && (
        <p className="flex items-start gap-1.5 py-1 text-[11px] text-muted">
          {result.wrote ? (
            <Check size={11} className="mt-0.5 shrink-0 text-ok" />
          ) : (
            <TriangleAlert size={11} className="mt-0.5 shrink-0 text-warn" />
          )}
          <span className="min-w-0">
            {result.cloud}: {result.detail}
          </span>
        </p>
      )}
    </>
  );
}

function CloudRow({
  cloud,
  busy,
  disabled,
  hint,
  onDiscover,
}: {
  cloud: CloudStatus;
  busy: boolean;
  disabled: boolean;
  hint: string;
  onDiscover: () => void;
}) {
  const t = useT();
  // What this row is waiting on. A cloud whose CLI cannot be asked who it is
  // stops at "signed in?" rather than claiming either answer - see cloud.rs.
  const command = !cloud.installed ? cloud.installHint : cloud.signedIn === false ? cloud.signInHint : null;
  const canDiscover = cloud.installed && cloud.signedIn !== false;

  return (
    <div className="flex items-center gap-2 py-0.5 text-[12px]">
      <Cloud size={12} className={`shrink-0 ${cloud.installed ? "text-accent" : "text-muted"}`} />
      <span className="w-28 shrink-0 truncate">{cloud.label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
        {command ?? cloud.account ?? t("cloud.signedInUnknown")}
      </span>
      {command !== null && <CopyButton text={command} />}
      {canDiscover && (
        <button
          onClick={onDiscover}
          disabled={disabled}
          title={hint === "" ? t("cloud.discover") : hint}
          className="shrink-0 rounded p-1 text-muted hover:bg-elevated hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Radar size={11} />}
        </button>
      )}
    </div>
  );
}

/** Copies a command, and says so for long enough to be believed. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const t = useT();

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => {
      setCopied(false);
    }, 1500);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);

  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
        });
      }}
      title={t("cloud.copy")}
      className="shrink-0 rounded p-1 text-muted hover:bg-elevated hover:text-accent"
    >
      {copied ? <Check size={11} className="text-ok" /> : <Copy size={11} />}
    </button>
  );
}
