import type { Locale } from "../i18n";

/**
 * What the welcome screen shows in its news column.
 *
 * One item is one thing that changed, in the reader's language, dated. Nothing
 * here is HTML: whatever ends up serving these must not be able to inject
 * markup into the editor's own window.
 */
export interface NewsItem {
  id: string;
  /** ISO date. Formatting is the reader's locale's business, not the writer's. */
  date: string;
  title: string;
  body: string;
}

/**
 * Placeholder news, shipped with the build.
 *
 * The portal that will serve these does not exist yet, so they are written here
 * and they are real - every one is something the editor actually gained. When
 * the portal arrives, `loadNews` is the only thing that changes: it already
 * returns a promise and is already given the locale, because a server would
 * need both and a function that has to grow those later would take its callers
 * with it.
 */
const PLACEHOLDER: Record<Locale, NewsItem[]> = {
  en: [
    {
      id: "logo-mark",
      date: "2026-10-11",
      title: "A quieter start",
      body: "The starting window and the home screen show Aime's own logo drawing itself, instead of a character.",
    },
    {
      id: "parallel-runs",
      date: "2026-08-24",
      title: "Two tickets at once",
      body: "A second task run takes a git worktree of its own, so two agents never edit the same files.",
    },
    {
      id: "azure-devops",
      date: "2026-08-19",
      title: "One Azure DevOps connection, several projects",
      body: "Connect once and pick the project per workspace, instead of a connection each.",
    },
  ],
  vi: [
    {
      id: "logo-mark",
      date: "2026-10-11",
      title: "Khởi động gọn gàng hơn",
      body: "Cửa sổ khởi động và màn hình home giờ là logo Aime tự vẽ ra, thay cho nhân vật.",
    },
    {
      id: "parallel-runs",
      date: "2026-08-24",
      title: "Chạy hai ticket cùng lúc",
      body: "Lượt chạy thứ hai lấy một git worktree riêng, nên hai AI không bao giờ sửa trùng file.",
    },
    {
      id: "azure-devops",
      date: "2026-08-19",
      title: "Một kết nối Azure DevOps, nhiều project",
      body: "Kết nối một lần rồi chọn project cho từng workspace, thay vì mỗi project một kết nối.",
    },
  ],
};

/** The news for this reader. One call, whoever ends up answering it. */
export function loadNews(locale: Locale): Promise<NewsItem[]> {
  return Promise.resolve(PLACEHOLDER[locale]);
}
