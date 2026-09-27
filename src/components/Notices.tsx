import { X } from "lucide-react";
import { useT } from "../i18n";
import { useNotices } from "../stores/notices";

/** The notices of `stores/notices.ts`, in the corner above the status bar. */
export function Notices() {
  const { notices, dismiss } = useNotices();
  const t = useT();
  if (notices.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-3 bottom-8 z-50 flex w-80 flex-col gap-1.5">
      {notices.map((notice) => (
        <div
          key={notice.id}
          role="alert"
          className="pointer-events-auto flex items-start gap-2 rounded-md border border-danger/50 bg-panel px-3 py-2 text-[12px] shadow-lg"
        >
          <span className="min-w-0 flex-1 break-words">
            <span className="text-danger">{notice.what}</span>
            <span className="text-muted"> - {notice.reason}</span>
          </span>
          <button
            onClick={() => {
              dismiss(notice.id);
            }}
            title={t("notice.dismiss")}
            className="shrink-0 rounded p-0.5 text-muted hover:bg-elevated hover:text-fg"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
