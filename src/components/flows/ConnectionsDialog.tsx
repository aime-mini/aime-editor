import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { KeyRound, Loader2, Mail, ShieldCheck, Trash2, X } from "lucide-react";
import { useT } from "../../i18n";
import { useFlows } from "../../stores/flows";
import { failedTo } from "../../stores/notices";

/**
 * The connections a flow may name: an API token or password kept in the OS
 * store as `{{secret.NAME}}`, a mail account, a sign-in to a service with
 * the person's own OAuth client. Values go to the backend once and never
 * come back; this dialog lists names.
 */
export function ConnectionsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const names = useFlows((s) => s.secretNames);
  const reload = useFlows((s) => s.loadSecrets);
  const [kind, setKind] = useState<"token" | "mail" | "oauth">("token");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [mail, setMail] = useState({
    host: "",
    port: "587",
    user: "",
    password: "",
    from: "",
    starttls: true,
  });
  const [oauth, setOauth] = useState({
    authUrl: "",
    tokenUrl: "",
    clientId: "",
    clientSecret: "",
    scopes: "",
  });

  const add = async () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    setBusy(true);
    try {
      if (kind === "token") {
        await invoke("secret_set", { name: trimmed, value });
      } else if (kind === "mail") {
        await invoke("mail_account_set", {
          name: trimmed,
          account: { ...mail, port: Number(mail.port) || 587 },
        });
      } else {
        await invoke("oauth_sign_in", {
          name: trimmed,
          client: { ...oauth, scopes: oauth.scopes.split(/[\s,]+/).filter((scope) => scope !== "") },
        });
      }
      await reload();
      setName("");
      setValue("");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (secret: string) => {
    await invoke("secret_delete", { name: secret });
    await reload();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-16" onClick={onClose}>
      <div
        role="dialog"
        aria-label={t("flows.hub.connections")}
        className="flex max-h-[80vh] w-[560px] max-w-[92vw] flex-col rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => {
          e.stopPropagation();
        }}
        data-flows-connections-dialog
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <KeyRound size={14} className="text-accent" />
          <span className="flex-1 text-[13px] font-semibold">{t("flows.hub.connections")}</span>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-elevated hover:text-fg">
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[12px]">
          <p className="mb-3 text-[11.5px] text-muted">{t("flows.connections.explain")}</p>
          <ul className="mb-4 flex flex-col gap-1">
            {names.length === 0 && <li className="text-muted">{t("flows.connections.none")}</li>}
            {names.map((secret) => (
              <li key={secret} className="flex items-center gap-2 rounded-md border border-line px-2 py-1">
                {secret.startsWith("mail.") ? (
                  <Mail size={12} className="text-muted" />
                ) : secret.startsWith("oauth.") ? (
                  <ShieldCheck size={12} className="text-muted" />
                ) : (
                  <KeyRound size={12} className="text-muted" />
                )}
                <span className="flex-1 font-mono text-[11.5px]">{secret}</span>
                {!secret.startsWith("oauth.") && !secret.startsWith("mail.") && (
                  <span className="text-[10.5px] text-muted">{`{{secret.${secret}}}`}</span>
                )}
                <button
                  onClick={() => void remove(secret).catch(failedTo(t("flows.connections.remove")))}
                  className="rounded p-1 text-muted hover:text-danger"
                  title={t("flows.connections.remove")}
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
          <div className="mb-2 flex overflow-hidden rounded border border-line text-[11.5px]">
            {(["token", "mail", "oauth"] as const).map((option) => (
              <button
                key={option}
                onClick={() => {
                  setKind(option);
                }}
                className={`flex-1 px-2 py-1 ${kind === option ? "bg-accent-soft text-accent" : "text-muted hover:bg-elevated hover:text-fg"}`}
              >
                {t(`flows.connections.${option}`)}
              </button>
            ))}
          </div>
          <p className="mb-2 text-[11px] text-muted">{t(`flows.connections.${kind}.hint`)}</p>
          <div className="flex flex-col gap-2">
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              placeholder={t("flows.connections.name")}
              className={input}
            />
            {kind === "token" && (
              <input
                type="password"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                }}
                placeholder={t("flows.connections.value")}
                className={input}
              />
            )}
            {kind === "mail" && (
              <>
                <div className="grid grid-cols-[1fr_90px] gap-2">
                  <input
                    value={mail.host}
                    onChange={(e) => {
                      setMail({ ...mail, host: e.target.value });
                    }}
                    placeholder="smtp.example.com"
                    className={input}
                  />
                  <input
                    value={mail.port}
                    onChange={(e) => {
                      setMail({ ...mail, port: e.target.value });
                    }}
                    placeholder="587"
                    className={input}
                  />
                </div>
                <input
                  value={mail.user}
                  onChange={(e) => {
                    setMail({ ...mail, user: e.target.value });
                  }}
                  placeholder={t("flows.connections.mailUser")}
                  className={input}
                />
                <input
                  type="password"
                  value={mail.password}
                  onChange={(e) => {
                    setMail({ ...mail, password: e.target.value });
                  }}
                  placeholder={t("flows.connections.mailPassword")}
                  className={input}
                />
                <input
                  value={mail.from}
                  onChange={(e) => {
                    setMail({ ...mail, from: e.target.value });
                  }}
                  placeholder={t("flows.connections.mailFrom")}
                  className={input}
                />
                <label className="flex items-center gap-2 text-[11.5px]">
                  <input
                    type="checkbox"
                    checked={mail.starttls}
                    onChange={(e) => {
                      setMail({ ...mail, starttls: e.target.checked });
                    }}
                  />{" "}
                  {t("flows.connections.starttls")}
                </label>
              </>
            )}
            {kind === "oauth" && (
              <>
                <input
                  value={oauth.authUrl}
                  onChange={(e) => {
                    setOauth({ ...oauth, authUrl: e.target.value });
                  }}
                  placeholder="https://…/authorize"
                  className={input}
                />
                <input
                  value={oauth.tokenUrl}
                  onChange={(e) => {
                    setOauth({ ...oauth, tokenUrl: e.target.value });
                  }}
                  placeholder="https://…/token"
                  className={input}
                />
                <input
                  value={oauth.clientId}
                  onChange={(e) => {
                    setOauth({ ...oauth, clientId: e.target.value });
                  }}
                  placeholder="client id"
                  className={input}
                />
                <input
                  type="password"
                  value={oauth.clientSecret}
                  onChange={(e) => {
                    setOauth({ ...oauth, clientSecret: e.target.value });
                  }}
                  placeholder={t("flows.connections.clientSecret")}
                  className={input}
                />
                <input
                  value={oauth.scopes}
                  onChange={(e) => {
                    setOauth({ ...oauth, scopes: e.target.value });
                  }}
                  placeholder={t("flows.connections.scopes")}
                  className={input}
                />
              </>
            )}
            <button
              onClick={() => void add().catch(failedTo(t("flows.connections.add")))}
              disabled={busy || name.trim() === ""}
              className="flex items-center gap-1.5 self-end rounded px-3 py-1.5 font-medium text-white bg-accent-strong hover:opacity-90 disabled:opacity-50"
              data-flows-connection-add
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : null}{" "}
              {kind === "oauth" ? t("flows.connections.signIn") : t("flows.connections.add")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const input =
  "w-full rounded border border-line bg-elevated px-2 py-1.5 text-[12px] outline-none focus:border-accent";
