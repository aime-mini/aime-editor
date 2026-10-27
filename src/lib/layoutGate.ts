import { DEPLOY_PROOF_DIR } from "./evidenceFile";
import type { Service } from "./testEnvironment";

/**
 * The layout gate of a task run: the screens a change shows on, opened by
 * Aime at a phone's, a tablet's and a desktop's width, and measured.
 *
 * Not a screenshot judged by eye, and not the AI's word that it looked fine:
 * geometry, read out of the rendered page - does the page scroll sideways,
 * which element runs past the edge, which text is cut off by its own box. The
 * AI says where the screens are and how to bring the app up
 * (`screens.json`); Aime starts it, opens each page in a webview of each size
 * (`page_probe` in Rust) and runs the script below in it.
 */

/** The widths a screen has to hold at: a common phone, a tablet in portrait, a laptop. */
export const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
] as const;
export type Viewport = (typeof VIEWPORTS)[number];

/** Where the AI says which screens the change shows on, beside the deploy proof. */
export const SCREENS_FILE = `${DEPLOY_PROOF_DIR}/screens.json`;

/** How long a page may take to load and settle before it is reported as not answering. */
export const PAGE_TIMEOUT_MS = 30_000;

/** What the AI wrote down: how to bring the app up, and the pages to measure. */
export interface Screens {
  serve: Service[];
  pages: string[];
}

/** Something on a page, named so a person can find it: `div.cart-total`, and its text. */
export interface Spot {
  element: string;
  text: string;
}

/** What the script measured on one page at one width. */
export interface LayoutReport {
  /** The width the page had to fit, as the page itself measured it. */
  width: number;
  /** How wide the page actually is; more than `width` means it scrolls sideways. */
  scrollWidth: number;
  /** The outermost elements that run past the right edge, with where they end. */
  overflowing: (Spot & { right: number })[];
  /** Text cut off by its own box - not an ellipsis someone chose, an edge it hit. */
  clipped: Spot[];
}

/** Elements looked at per page: enough for any real screen, bounded for a pathological one. */
const ELEMENT_LIMIT = 5_000;
/** Problems reported per kind and page: past this the reader knows what kind of page it is. */
const SPOT_LIMIT = 10;
/** Time after navigation before a page is measured, so a client-rendered screen has drawn. */
const SETTLE_MS = 1_500;

/** Reads `screens.json`; null when it is not the shape the deliver prompt asks for. */
export function parseScreens(text: string): Screens | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { serve, pages } = value as { serve?: unknown; pages?: unknown };
  if (!Array.isArray(pages)) return null;
  return {
    serve: (Array.isArray(serve) ? serve : []).flatMap((one: unknown): Service[] => {
      if (typeof one !== "object" || one === null) return [];
      const { command, dir, ready } = one as { command?: unknown; dir?: unknown; ready?: unknown };
      if (typeof command !== "string" || typeof ready !== "string") return [];
      return [{ command, dir: typeof dir === "string" && dir !== "" ? dir : ".", ready }];
    }),
    pages: pages.filter((page): page is string => typeof page === "string" && /^https?:\/\//.test(page)),
  };
}

/**
 * The script run inside the page. It answers only once the page is this
 * origin's (not a browser error page), loaded, its fonts in, and settled; then
 * it leaves its report in the fragment, where `page_probe` reads it.
 *
 * An element inside a container meant to scroll sideways is not overflow - a
 * table in a scroller is a design - and text that ends in an ellipsis or a
 * line clamp was cut on purpose. A box of a pixel or two is a visually hidden
 * label for screen readers, cut on purpose too.
 */
export function probeScript(origin: string): string {
  return `(() => {
  if (location.origin !== ${JSON.stringify(origin)} || document.readyState !== "complete") return;
  if ((document.fonts && document.fonts.status !== "loaded") || performance.now() < ${String(SETTLE_MS)}) return;
  const width = document.documentElement.clientWidth;
  const name = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.id) return tag + "#" + el.id;
    const classes = typeof el.className === "string" ? el.className.trim().split(/\\s+/).filter(Boolean) : [];
    return classes.length > 0 ? tag + "." + classes.slice(0, 2).join(".") : tag;
  };
  const words = (el) => (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60);
  const shown = (el, box) => box.width > 2 && box.height > 2 && getComputedStyle(el).visibility !== "hidden";
  const inScroller = (el) => {
    for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(up).overflowX)) return true;
    }
    return false;
  };
  const all = [...document.body.querySelectorAll("*")].slice(0, ${String(ELEMENT_LIMIT)});
  const overflowing = [];
  if (document.documentElement.scrollWidth > width + 1) {
    for (const el of all) {
      const box = el.getBoundingClientRect();
      if (!shown(el, box) || box.right <= width + 1) continue;
      if (overflowing.some((one) => one.node.contains(el)) || inScroller(el)) continue;
      overflowing.push({ node: el, element: name(el), text: words(el), right: Math.round(box.right) });
      if (overflowing.length >= ${String(SPOT_LIMIT)}) break;
    }
  }
  const clipped = [];
  for (const el of all) {
    if (![...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim() !== "")) continue;
    const style = getComputedStyle(el);
    if (style.textOverflow === "ellipsis" || (style.webkitLineClamp && style.webkitLineClamp !== "none")) continue;
    if (!/(hidden|clip)/.test(style.overflowX + " " + style.overflowY)) continue;
    if (!shown(el, el.getBoundingClientRect())) continue;
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
      clipped.push({ element: name(el), text: words(el) });
      if (clipped.length >= ${String(SPOT_LIMIT)}) break;
    }
  }
  const report = {
    width,
    scrollWidth: document.documentElement.scrollWidth,
    overflowing: overflowing.map(({ node, ...spot }) => spot),
    clipped,
  };
  history.replaceState(history.state, "", location.pathname + location.search + "#aime-probe=" + encodeURIComponent(JSON.stringify(report)));
})();`;
}

/** The report `page_probe` carried back, or null when it is not one. */
export function readProbe(answer: string): LayoutReport | null {
  let value: unknown;
  try {
    value = JSON.parse(decodeURIComponent(answer));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const report = value as Partial<LayoutReport>;
  if (typeof report.width !== "number" || typeof report.scrollWidth !== "number") return null;
  if (!Array.isArray(report.overflowing) || !Array.isArray(report.clipped)) return null;
  return report as LayoutReport;
}

/** What is wrong with one page at one width, one line per problem, for the agent and the reader. */
export function layoutProblems(page: string, viewport: Viewport, report: LayoutReport): string[] {
  const where = `${viewport.name} ${String(viewport.width)}px · ${page}`;
  const sideways =
    report.scrollWidth > report.width + 1
      ? [
          `${where}: the page scrolls sideways (${String(report.scrollWidth)}px wide in a ${String(report.width)}px window)` +
            report.overflowing
              .map((spot) => `; ${spot.element} reaches ${String(spot.right)}px${quoted(spot.text)}`)
              .join(""),
        ]
      : [];
  const cut = report.clipped.map(
    (spot) => `${where}: text cut off by its box in ${spot.element}${quoted(spot.text)}`,
  );
  return [...sideways, ...cut];
}

function quoted(text: string): string {
  return text === "" ? "" : ` - "${text}"`;
}
