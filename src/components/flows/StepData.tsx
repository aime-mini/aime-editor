/**
 * What a step was given, made or said in a run - shared by the designer's
 * inspector (the newest run) and the run screen (the run on screen).
 */

/** A value as pretty JSON under its title, the step's error above it, or why there is nothing. */
export function DataView({
  title,
  value,
  error,
  empty,
}: {
  title: string;
  value: unknown;
  error?: string;
  empty: string;
}) {
  if (value === undefined && error === undefined)
    return <p className="px-3 py-3 text-[11.5px] text-muted">{empty}</p>;
  return (
    <div className="px-3 py-3">
      {title !== "" && <p className="mb-1 text-[11.5px]">{title}</p>}
      {error !== undefined && (
        <p className="mb-1 rounded-md bg-danger/10 px-2 py-1 text-[11.5px] text-danger">{error}</p>
      )}
      {value !== undefined && (
        <pre className="max-h-[60vh] overflow-auto rounded bg-bg px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** The lines a step logged, oldest first, or why there are none. */
export function LogView({ lines, empty }: { lines: readonly string[] | undefined; empty: string }) {
  return (
    <pre className="px-3 py-3 font-mono text-[11px] whitespace-pre-wrap text-muted" data-flow-log>
      {lines === undefined || lines.length === 0 ? empty : lines.join("\n")}
    </pre>
  );
}
