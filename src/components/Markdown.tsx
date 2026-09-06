import { Fragment, useMemo, type CSSProperties, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { parseMarkdown, type Alignment, type Block, type Inline } from "../lib/markdown";

/**
 * Markdown, read.
 *
 * Everything on screen is built from the model `parseMarkdown` returns, so
 * nothing a work item carries can become markup of its own - no `dangerously`
 * anything, and a description that contains a script tag is a description that
 * contains the words of a script tag.
 *
 * Links leave through the operating system rather than through the webview: this
 * is an editor, and following a ticket's link inside it would replace the app.
 */
/**
 * @param tail drawn right after the last word - the streaming caret of a chat
 *   turn, which has to sit where the next character will appear, not on a line
 *   of its own under the paragraph.
 */
export function Markdown({ text, tail }: { text: string; tail?: ReactNode }) {
  // Parsed once per text: a finished message re-rendered beside a streaming one
  // does not pay for its own parse again on every frame.
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  if (blocks.length === 0) return <>{tail}</>;
  return (
    <div className="space-y-3 text-[13px] leading-relaxed break-words text-fg/90">
      {blocks.map((block, index) => (
        <Rendered key={index} block={block} tail={index === blocks.length - 1 ? tail : undefined} />
      ))}
    </div>
  );
}

/** How much one level of nesting is indented on screen. */
const NEST_INDENT_REM = 1.1;

/** Heading sizes, largest first; anything deeper than three reads as the third. */
const HEADING_SIZES = ["text-[15px]", "text-[14px]", "text-[13px]"];

function Rendered({ block, tail }: { block: Block; tail?: ReactNode }) {
  switch (block.kind) {
    case "heading":
      return (
        <h3
          className={`mt-4 font-semibold text-fg first:mt-0 ${
            HEADING_SIZES[Math.min(block.level, HEADING_SIZES.length) - 1]
          }`}
        >
          <Spans spans={block.spans} />
          {tail}
        </h3>
      );

    case "paragraph":
      return (
        <p className="whitespace-pre-wrap">
          <Spans spans={block.spans} />
          {tail}
        </p>
      );

    case "list":
      return (
        <ul className="space-y-1">
          {block.items.map((item, index) => (
            <li
              key={index}
              className="flex gap-2"
              style={{ marginLeft: `${String(item.depth * NEST_INDENT_REM)}rem` }}
            >
              <span className="shrink-0 select-none text-muted">
                {block.ordered ? `${String(index + 1)}.` : "•"}
              </span>
              <span className="min-w-0 flex-1">
                <Spans spans={item.spans} />
                {index === block.items.length - 1 && tail}
              </span>
            </li>
          ))}
        </ul>
      );

    case "code":
      return (
        <>
          <pre className="overflow-x-auto rounded-md border border-line bg-elevated px-3 py-2 font-mono text-[12px] leading-relaxed">
            <code>{block.text}</code>
          </pre>
          {tail}
        </>
      );

    case "quote":
      return (
        <blockquote className="border-l-2 border-line pl-3 text-muted">
          <Spans spans={block.spans} />
          {tail}
        </blockquote>
      );

    case "rule":
      return (
        <>
          <hr className="border-line" />
          {tail}
        </>
      );

    case "table":
      // Scrolls inside its own box: a wide table must never make the whole
      // transcript scroll sideways.
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr>
                {block.header.map((cell, column) => (
                  <th
                    key={column}
                    style={cellStyle(block.align[column])}
                    className="border-b border-line px-2 py-1 text-left font-semibold whitespace-nowrap text-fg"
                  >
                    <Spans spans={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={index} className="border-b border-line/50 last:border-0">
                  {row.map((cell, column) => (
                    <td key={column} style={cellStyle(block.align[column])} className="px-2 py-1 align-top">
                      <Spans spans={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {tail}
        </div>
      );
  }
}

/** The one thing a delimiter row can ask of a column. */
function cellStyle(alignment: Alignment): CSSProperties | undefined {
  return alignment === null ? undefined : { textAlign: alignment };
}

function Spans({ spans }: { spans: Inline[] }) {
  return (
    <>
      {spans.map((span, index) => (
        <Fragment key={index}>
          <Span span={span} />
        </Fragment>
      ))}
    </>
  );
}

function Span({ span }: { span: Inline }) {
  switch (span.kind) {
    case "text":
      return span.text;

    case "code":
      return (
        <code className="rounded border border-line bg-elevated px-1 py-px font-mono text-[12px]">
          {span.text}
        </code>
      );

    case "link":
      return (
        <button
          onClick={() => {
            openUrl(span.href).catch(console.error);
          }}
          title={span.href}
          className="text-accent hover:underline"
        >
          {span.text}
        </button>
      );

    case "strong":
      return (
        <strong className="font-semibold text-fg">
          <Spans spans={span.spans} />
        </strong>
      );

    case "emphasis":
      return (
        <em>
          <Spans spans={span.spans} />
        </em>
      );

    case "strike":
      return (
        <s className="text-muted">
          <Spans spans={span.spans} />
        </s>
      );
  }
}
