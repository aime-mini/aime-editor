import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { Newspaper, Sparkles } from "lucide-react";
import { useI18n, useT } from "../i18n";
import { loadNews, type NewsItem } from "../lib/news";
import { useSettings } from "../stores/settings";

/** What `update_check` says about a version the user does not have yet. */
interface UpdateSummary {
  version: string;
  notes: string | null;
  date: string | null;
}

/**
 * The welcome screen's right-hand column: what changed, and what is new.
 *
 * It reports the update rather than installing it - the bar across the top of
 * the window already owns that, and two buttons that download the same file is
 * one too many.
 */
export function HomeNews() {
  const locale = useI18n((s) => s.locale);
  const channel = useSettings((s) => s.updateChannel);
  const t = useT();
  const [version, setVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateSummary | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);

  useEffect(() => {
    let stale = false;
    // Nothing here is worth a word to the user if it fails: a home screen that
    // reports its own plumbing is a home screen nobody trusts.
    getVersion()
      .then((found) => {
        if (!stale) setVersion(found);
      })
      .catch((err: unknown) => {
        console.warn("app version unavailable:", err);
      });
    invoke<UpdateSummary | null>("update_check", { channel })
      .then((found) => {
        if (!stale) setUpdate(found);
      })
      .catch((err: unknown) => {
        console.warn("update check skipped:", err);
      });
    return () => {
      stale = true;
    };
  }, [channel]);

  useEffect(() => {
    let stale = false;
    loadNews(locale)
      .then((items) => {
        if (!stale) setNews(items);
      })
      .catch((err: unknown) => {
        console.warn("news unavailable:", err);
      });
    return () => {
      stale = true;
    };
  }, [locale]);

  const dateFormat = new Intl.DateTimeFormat(locale === "vi" ? "vi-VN" : "en-GB", {
    day: "numeric",
    month: "short",
  });
  const heading = "text-[11px] font-semibold tracking-wider text-muted uppercase";

  return (
    <>
      <section>
        <h2 className={`${heading} flex items-center gap-1.5`}>
          <Sparkles size={12} /> {t("home.updates")}
        </h2>
        <div className="mt-3 rounded-lg border border-line px-3 py-2.5">
          {update ? (
            <>
              <p className="font-medium text-accent">
                {t("home.updateAvailable", { version: update.version })}
              </p>
              <p className="mt-1 text-[11px] text-muted">{t("home.updateHint")}</p>
            </>
          ) : (
            <p className="text-muted">{t("home.upToDate")}</p>
          )}
          {version && <p className="mt-1 text-[11px] text-muted">{t("home.version", { version })}</p>}
        </div>
      </section>

      <section className="mt-8">
        <h2 className={`${heading} flex items-center gap-1.5`}>
          <Newspaper size={12} /> {t("home.news")}
        </h2>
        <div className="mt-3 flex flex-col gap-3">
          {news.map((item) => (
            <article key={item.id}>
              <p className="text-[11px] text-muted">{dateFormat.format(new Date(item.date))}</p>
              <p className="font-medium text-fg">{item.title}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{item.body}</p>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
