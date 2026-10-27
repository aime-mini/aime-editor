import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { useT } from "../i18n";
import type { TranslationKey } from "../i18n/en";
import { parseCsv, type Delimiter } from "../lib/csv";

/**
 * A delimited file as the table it is.
 *
 * Read-only on purpose: a table cell editor is a spreadsheet, and the text
 * behind the table is one click away for anyone who wants to change it. What
 * this view does is what a text editor cannot: line the columns up, keep the
 * header in sight, right-align the numbers, and let a person find a row by
 * typing rather than by scrolling. Rows past `ROWS_SHOWN` are not drawn - a
 * hundred-thousand-row export is read by searching, not by scrolling - and the
 * search box searches every row whether or not it is on screen.
 */

/** Rows drawn before the rest is folded behind a count; the search reaches them all. */
const ROWS_SHOWN = 2_000;

const DELIMITER_LABELS: Record<Delimiter, TranslationKey> = {
  ",": "csv.comma",
  ";": "csv.semicolon",
  "\t": "csv.tab",
  "|": "csv.pipe",
};

export function CsvView({ text }: { text: string }) {
  const t = useT();
  const table = useMemo(() => parseCsv(text), [text]);
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown = useMemo(
    () =>
      needle === ""
        ? table.rows
        : table.rows.filter((row) => row.some((cell) => cell.toLowerCase().includes(needle))),
    [table.rows, needle],
  );
  const drawn = shown.slice(0, ROWS_SHOWN);

  if (table.header.length === 0) {
    return <div className="flex h-full items-center justify-center text-muted">{t("csv.empty")}</div>;
  }

  return (
    <div className="flex h-full flex-col text-[12px]">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-1.5 text-muted">
        <span className="tabular-nums">{t("csv.rows", { count: table.rows.length })}</span>
        <span className="tabular-nums">{t("csv.columns", { count: table.header.length })}</span>
        <span>{t(DELIMITER_LABELS[table.delimiter])}</span>
        <label className="flex min-w-48 flex-1 items-center gap-1.5 rounded border border-line bg-panel px-2 py-1">
          <Search size={11} className="shrink-0" />
          <input
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
            placeholder={t("csv.filter")}
            className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-muted"
          />
          {filter !== "" && (
            <button
              onClick={() => {
                setFilter("");
              }}
              className="hover:text-fg"
            >
              <X size={11} />
            </button>
          )}
        </label>
        {needle !== "" && <span className="tabular-nums">{t("csv.matching", { count: shown.length })}</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {shown.length === 0 ? (
          <p className="p-4 text-muted">{t("csv.noMatch")}</p>
        ) : (
          <table className="border-collapse whitespace-nowrap">
            <thead className="sticky top-0 z-10 bg-panel">
              <tr>
                <th className="border-r border-b border-line px-2 py-1 text-right font-normal text-muted tabular-nums">
                  #
                </th>
                {table.header.map((cell, column) => (
                  <th
                    key={column}
                    className={`border-r border-b border-line px-2 py-1 font-semibold ${
                      table.numeric[column] ? "text-right" : "text-left"
                    }`}
                  >
                    {cell === "" ? <span className="text-muted">{t("csv.unnamed")}</span> : cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {drawn.map((row, index) => (
                <tr key={index} className="odd:bg-bg even:bg-panel/40 hover:bg-elevated">
                  <td className="border-r border-b border-line/60 px-2 py-0.5 text-right text-muted tabular-nums">
                    {index + 1}
                  </td>
                  {row.map((cell, column) => (
                    <td
                      key={column}
                      className={`max-w-[32rem] truncate border-r border-b border-line/60 px-2 py-0.5 ${
                        table.numeric[column] ? "text-right tabular-nums" : "text-left"
                      }`}
                      title={cell}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {shown.length > ROWS_SHOWN && (
          <p className="px-3 py-2 text-muted">{t("csv.andMore", { count: shown.length - ROWS_SHOWN })}</p>
        )}
      </div>
    </div>
  );
}
