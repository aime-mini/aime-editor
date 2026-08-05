import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";

interface PromptModalProps {
  title: string;
  /** Text under the title (confirm mode). */
  hint?: string;
  /** When set, shows a text input prefilled with this value; omit for a plain confirm. */
  initialValue?: string;
  /** Allow submitting an empty value (optional inputs like stash messages). */
  allowEmpty?: boolean;
  danger?: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

/** Small centered dialog for naming and confirmations — replaces window.prompt/confirm. */
export function PromptModal({
  title,
  hint,
  initialValue,
  allowEmpty,
  danger,
  onSubmit,
  onClose,
}: PromptModalProps) {
  const [value, setValue] = useState(initialValue ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();
  const hasInput = initialValue !== undefined;

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const submit = () => {
    if (hasInput && !allowEmpty && !value.trim()) return;
    onSubmit(value.trim());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-32" onClick={onClose}>
      <div
        className="w-80 rounded-lg border border-line bg-panel p-4 shadow-xl"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <p className="font-medium">{title}</p>
        {hint && <p className="mt-1 text-muted">{hint}</p>}
        {hasInput && (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") onClose();
            }}
            className="mt-3 w-full rounded border border-line bg-elevated px-2 py-1.5 outline-none focus:border-accent"
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-muted hover:bg-elevated hover:text-fg"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={submit}
            className={`rounded px-3 py-1.5 font-medium text-white ${danger ? "bg-danger" : "bg-accent-strong"} hover:opacity-90`}
          >
            {t("common.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
