import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useI18n, useT } from "../i18n";
import { HELP_TOPICS, searchHelp } from "../lib/helpContent";

/** Searchable in-app help (F1). Content lives in lib/helpContent.ts. */
export function HelpModal({ onClose }: { onClose: () => void }) {
  const locale = useI18n((s) => s.locale);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  useEffect(() => {
    inputRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const results = useMemo(() => searchHelp(HELP_TOPICS[locale], query), [locale, query]);
  const sections = useMemo(() => [...new Set(results.map((r) => r.section))], [results]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-16" onClick={onClose}>
      <div
        className="flex max-h-[75vh] w-[560px] max-w-[90vw] flex-col rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Search size={14} className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            placeholder={t("help.searchPlaceholder")}
            className="flex-1 bg-transparent outline-none placeholder:text-muted"
          />
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-elevated hover:text-fg">
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {results.length === 0 && <p className="py-6 text-center text-muted">{t("help.noResults")}</p>}
          {sections.map((section) => (
            <section key={section} className="mb-4">
              <h2 className="mb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">
                {section}
              </h2>
              {results
                .filter((topic) => topic.section === section)
                .map((topic) => (
                  <div key={topic.id} className="mb-2.5">
                    <h3 className="font-medium text-fg">{topic.title}</h3>
                    <p className="leading-relaxed text-muted">{topic.body}</p>
                  </div>
                ))}
            </section>
          ))}
        </div>

        <div className="border-t border-line px-4 py-2 text-[11px] text-muted">{t("help.footer")}</div>
      </div>
    </div>
  );
}
