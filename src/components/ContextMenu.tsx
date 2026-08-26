import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n";
import { fuzzyFilter } from "../lib/fuzzy";
import { MENU_MARGIN, placeMenu, type Placement } from "../lib/menuPlacement";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  onClick: () => void;
}

/** A line between two groups of entries that answer different questions. */
export const SEPARATOR = "separator" as const;

interface ContextMenuProps {
  x: number;
  y: number;
  items: (MenuItem | typeof SEPARATOR)[];
  onClose: () => void;
}

/**
 * From this many entries on, the menu comes with a filter box. The branch list
 * of a repository a team has worked in for years is not something anyone reads
 * through, and scrolling alone leaves the searching to the user.
 */
const FILTER_FROM = 12;

/** Custom right-click menu — replaces the webview's default browser menu. */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement>({ left: x, top: y });
  const [query, setQuery] = useState("");
  const t = useT();

  const entries = useMemo(() => items.filter((item): item is MenuItem => item !== SEPARATOR), [items]);
  const searchable = entries.length >= FILTER_FROM;
  const needle = query.trim();
  /**
   * Filtered, the groups the separators mark no longer exist: what is left is
   * one list ranked by how well it matches, the way the palette ranks its rows.
   */
  const shown: (MenuItem | typeof SEPARATOR)[] = useMemo(
    () =>
      searchable && needle !== ""
        ? fuzzyFilter(entries, needle, (item) => item.label, entries.length).map((hit) => hit.item)
        : items,
    [entries, items, needle, searchable],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  // Measured, then placed - and measured again when the filter changes how tall
  // it is. A layout effect, so the window is never painted with it misplaced.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPlacement(
      placeMenu(
        { x, y },
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [x, y, shown.length]);

  const pick = (item: MenuItem) => {
    onClose();
    item.onClick();
  };
  /** What Enter takes: the best match, which is what the list is sorted by. */
  const best = shown.find((item): item is MenuItem => item !== SEPARATOR);

  return (
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      <div
        ref={ref}
        role="menu"
        style={{
          left: placement.left,
          top: placement.top,
          maxHeight: `calc(100vh - ${String(MENU_MARGIN * 2)}px)`,
        }}
        className="absolute flex max-w-[min(24rem,90vw)] min-w-40 flex-col overflow-hidden rounded-lg border border-line bg-elevated shadow-xl"
        // A click outside closes the menu; typing in its own filter box is not
        // outside it.
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        {searchable && (
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && best) pick(best);
            }}
            placeholder={t("menu.filter")}
            spellCheck={false}
            className="m-1 rounded border border-line bg-panel px-2 py-1 text-fg outline-none focus:border-accent"
          />
        )}
        <div role="group" className="overflow-y-auto py-1">
          {shown.length === 0 ? (
            <div className="px-3 py-1.5 text-muted">{t("menu.noMatch")}</div>
          ) : (
            shown.map((item, index) =>
              item === SEPARATOR ? (
                <hr key={`separator-${String(index)}`} role="separator" className="my-1 border-line" />
              ) : (
                <button
                  key={`${item.label}-${String(index)}`}
                  role="menuitem"
                  onClick={() => {
                    pick(item);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent-soft ${
                    item.danger ? "text-danger" : "text-fg"
                  }`}
                >
                  {item.icon}
                  <span className="truncate">{item.label}</span>
                </button>
              ),
            )
          )}
        </div>
      </div>
    </div>
  );
}
