import { useEffect } from "react";
import { editor as monacoEditor, Range as MonacoRange, type editor as MonacoEditor } from "monaco-editor";
import { displayLine, hasRule, type EditorBreakpoint } from "../lib/dap/launch";
import { samePath } from "../lib/dap/paths";
import { useDebug } from "../stores/debug";

/** The rules, as the gutter's hover shows them. */
function ruleText(breakpoint: EditorBreakpoint): string {
  return [
    breakpoint.condition === undefined ? null : `when \`${breakpoint.condition}\``,
    breakpoint.hitCondition === undefined ? null : `hits \`${breakpoint.hitCondition}\``,
    breakpoint.logMessage === undefined ? null : `logs \`${breakpoint.logMessage}\``,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
}

/** Same list, same order — the cheap way to know a sync would change nothing. */
function sameLines(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/**
 * Breakpoints in the gutter, and the line execution is paused on.
 *
 * Breakpoints are held as Monaco decorations as well as in the store, and that
 * is deliberate: a decoration moves with the text. Type three lines above a
 * breakpoint and Monaco has already shifted it, so the editor reads the new
 * lines back out and tells the store — which is what keeps a breakpoint on the
 * statement the user pointed at instead of on a line number.
 *
 * The marker itself is drawn on the line the *adapter* reported, not the one
 * that was clicked: measured, both js-debug and debugpy move a breakpoint to
 * the nearest executable statement (ARCHITECTURE.md §5), and a marker that
 * disagrees with where the program stops is worse than no marker.
 */
export function useDebugGutter(
  editor: MonacoEditor.IStandaloneCodeEditor | null,
  openFilePath: string | null,
): void {
  useEffect(() => {
    if (!editor || !openFilePath) return;

    const breakpointDecorations = editor.createDecorationsCollection();
    const executionDecorations = editor.createDecorationsCollection();

    const linesInStore = (): number[] =>
      (useDebug.getState().breakpoints[openFilePath] ?? []).map(displayLine);

    const inStore = (): EditorBreakpoint[] => useDebug.getState().breakpoints[openFilePath] ?? [];

    const draw = (): void => {
      breakpointDecorations.set(
        inStore().map((breakpoint) => ({
          range: new MonacoRange(displayLine(breakpoint), 1, displayLine(breakpoint), 1),
          options: {
            // A conditional breakpoint that looks identical to a plain one is how
            // people lose an afternoon wondering why the program did not stop.
            glyphMarginClassName: hasRule(breakpoint) ? "debug-breakpoint-rule" : "debug-breakpoint",
            glyphMarginHoverMessage: hasRule(breakpoint) ? { value: ruleText(breakpoint) } : undefined,
            // A breakpoint belongs to the line, and stays there while the line
            // is edited rather than stretching over what is typed next to it.
            stickiness: 1, // NeverGrowsWhenTypingAtEdges
          },
        })),
      );

      const { location } = useDebug.getState();
      const here = location !== null && samePath(location.path, openFilePath) ? location : null;
      executionDecorations.set(
        here
          ? [
              {
                range: new MonacoRange(here.line, 1, here.line, 1),
                options: {
                  isWholeLine: true,
                  className: "debug-execution-line",
                  glyphMarginClassName: "debug-execution-arrow",
                },
              },
            ]
          : [],
      );
      if (here) editor.revealLineInCenterIfOutsideViewport(here.line);
    };

    draw();
    // Redrawn only when something visible changed: a printing program pushes
    // output events by the hundred, and none of them move a marker.
    const unsubscribe = useDebug.subscribe((state, previous) => {
      const movedBreakpoints = state.breakpoints[openFilePath] !== previous.breakpoints[openFilePath];
      if (movedBreakpoints || state.location !== previous.location) draw();
    });

    // A click in the glyph margin is the one gesture every editor shares.
    const clicks = editor.onMouseDown((event) => {
      if (event.target.type !== monacoEditor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      // The store decides whether this file can hold a breakpoint at all; the
      // margin itself stays put, because one that came and went per file would
      // shift the text sideways every time the tab changed.
      void useDebug.getState().toggleBreakpoint(openFilePath, event.target.position.lineNumber);
    });

    const edits = editor.onDidChangeModelContent(() => {
      // Monaco has already moved the decorations; the store learns the new
      // lines from them rather than trying to replay the edit itself.
      const moved = breakpointDecorations
        .getRanges()
        .map((range) => range.startLineNumber)
        .sort((a, b) => a - b);
      const expected = linesInStore();
      if (!sameLines(moved, expected)) {
        useDebug.getState().replaceBreakpoints(openFilePath, moved);
      }
    });

    return () => {
      unsubscribe();
      clicks.dispose();
      edits.dispose();
      breakpointDecorations.clear();
      executionDecorations.clear();
    };
  }, [editor, openFilePath]);
}
