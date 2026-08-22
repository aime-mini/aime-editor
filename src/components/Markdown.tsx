import { Fragment } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { parseMarkdown, type Block, type Inline } from "../lib/markdown";

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
export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="space-y-3 text-[13px] leading-relaxed break-words text-fg/90">
      {blocks.map((block, index) => (
        <Rendered key={index} block={block} />
      ))}
    </div>
  );
}

/** How much one level of nesting is indented on screen. */
const NEST_INDENT_REM = 1.1;

/** Heading sizes, largest first; anything deeper than three reads as the third. */
const HEADING_SIZES = ["text-[15px]", "text-[14px]", "text-[13px]"];

function Rendered({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading":
      return (
        <h3
          className={`mt-4 font-semibold text-fg first:mt-0 ${
            HEADING_SIZES[Math.min(block.level, HEADING_SIZES.length) - 1]
          }`}
        >
          <Spans spans={block.spans} />
        </h3>
      );

    case "paragraph":
      return (
        <p className="whitespace-pre-wrap">
          <Spans spans={block.spans} />
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
              </span>
            </li>
          ))}
        </ul>
      );

    case "code":
      return (
        <pre className="overflow-x-auto rounded-md border border-line bg-elevated px-3 py-2 font-mono text-[12px] leading-relaxed">
          <code>{block.text}</code>
        </pre>
      );

    case "quote":
      return (
        <blockquote className="border-l-2 border-line pl-3 text-muted">
          <Spans spans={block.spans} />
        </blockquote>
      );

    case "rule":
      return <hr className="border-line" />;
  }
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
