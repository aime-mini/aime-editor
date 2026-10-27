import { createContext, Fragment, useContext, useMemo, type CSSProperties, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { mentionInCode, mentionInHref, mentionsInText, pathsMentionedIn } from "../lib/chatPaths";
import { parseMarkdown, type Alignment, type Block, type Inline } from "../lib/markdown";
import { failedTo } from "../stores/notices";
import { translate } from "../i18n";
import { PathLink } from "./PathLink";
import { usePathKinds, type PathKind } from "./usePathKinds";

/**
 * The files and folders this text names that exist, for a text whose paths are
 * links: the workspace relative ones are read against, and what the disk said.
 */
interface PathLinking {
  root: string;
  kinds: ReadonlyMap<string, PathKind>;
}

const PathLinkingContext = createContext<PathLinking | null>(null);

const NO_PATHS: readonly string[] = [];

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
 *
 * Given the workspace as `root`, it reads the files and folders the text names
 * as well - in its words, its code spans, its links - and the ones that exist
 * on disk become links of their own (`PathLink`).
 */
/**
 * @param tail drawn right after the last word - the streaming caret of a chat
 *   turn, which has to sit where the next character will appear, not on a line
 *   of its own under the paragraph.
 * @param root the workspace, for a text whose paths should be links.
 */
export function Markdown({ text, tail, root }: { text: string; tail?: ReactNode; root?: string }) {
  // Parsed once per text: a finished message re-rendered beside a streaming one
  // does not pay for its own parse again on every frame.
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const mentioned = useMemo(
    () => (root === undefined ? NO_PATHS : pathsMentionedIn(blocks, root)),
    [blocks, root],
  );
  const kinds = usePathKinds(mentioned);
  if (blocks.length === 0) return <>{tail}</>;
  return (
    <PathLinkingContext.Provider value={root === undefined ? null : { root, kinds }}>
      <div className="space-y-3 text-[13px] leading-relaxed break-words text-fg/90">
        {blocks.map((block, index) => (
          <Rendered key={index} block={block} tail={index === blocks.length - 1 ? tail : undefined} />
        ))}
      </div>
    </PathLinkingContext.Provider>
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

/** Running text, with the paths in it that exist made links. */
function Words({ text }: { text: string }) {
  const linking = useContext(PathLinkingContext);
  if (linking === null) return text;
  const pieces: ReactNode[] = [];
  let at = 0;
  for (const mention of mentionsInText(text, linking.root)) {
    const kind = linking.kinds.get(mention.path);
    if (kind === undefined) continue;
    pieces.push(text.slice(at, mention.start));
    pieces.push(
      <PathLink key={mention.start} path={mention.path} kind={kind} line={mention.line}>
        {text.slice(mention.start, mention.end)}
      </PathLink>,
    );
    at = mention.end;
  }
  if (at === 0) return text;
  pieces.push(text.slice(at));
  return <>{pieces}</>;
}

function Code({ text }: { text: string }) {
  const linking = useContext(PathLinkingContext);
  const code = (
    <code className="rounded border border-line bg-elevated px-1 py-px font-mono text-[12px]">{text}</code>
  );
  const mention = linking === null ? null : mentionInCode(text, linking.root);
  const kind = mention === null ? undefined : linking?.kinds.get(mention.path);
  if (mention === null || kind === undefined) return code;
  return (
    <PathLink path={mention.path} kind={kind} line={mention.line}>
      {code}
    </PathLink>
  );
}

/**
 * A link: to the browser for a web address, to a `PathLink` for a file or
 * folder that exists. A local target that does not exist is shown as the words
 * it is - the browser could not open it either.
 */
function Link({ text, href }: { text: string; href: string }) {
  const linking = useContext(PathLinkingContext);
  const mention = linking === null ? null : mentionInHref(href, linking.root);
  if (mention !== null) {
    const kind = linking?.kinds.get(mention.path);
    if (kind === undefined) return text;
    return (
      <PathLink path={mention.path} kind={kind} line={mention.line}>
        {text}
      </PathLink>
    );
  }
  return (
    <button
      onClick={() => {
        openUrl(href).catch(failedTo(translate("notice.openLink", { url: href })));
      }}
      title={href}
      className="text-accent hover:underline"
    >
      {text}
    </button>
  );
}

function Span({ span }: { span: Inline }) {
  switch (span.kind) {
    case "text":
      return <Words text={span.text} />;

    case "code":
      return <Code text={span.text} />;

    case "link":
      return <Link text={span.text} href={span.href} />;

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
