import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useTheme, type Theme } from "../stores/theme";
import { useWorkspace } from "../stores/workspace";

interface TermDataPayload {
  term_id: number;
  data: number[];
}

interface TermExitPayload {
  term_id: number;
}

/**
 * xterm palette: the app's own surfaces, VS Code's ANSI colors.
 *
 * The surface and the text are Aime's (`index.css`) so the terminal belongs to
 * the window it sits in. The 16 ANSI slots are VS Code's defaults, copied from
 * the installed build (`workbench.desktop.main.js`, terminal color registry) —
 * they are what every CLI on this machine was coloured against, and a palette
 * invented here made `git status` and PowerShell error text read differently
 * from the same output one window over.
 *
 * The cursor follows the text colour rather than the accent: a saturated block
 * one cell tall is the loudest thing on screen, which is not what a caret is
 * for. VS Code paints it `#bfbfbf` / `#202020` for the same reason.
 */
function xtermThemeOf(theme: Theme): ITheme {
  return theme === "dark"
    ? {
        background: "#1c1f26",
        foreground: "#d7dae0",
        cursor: "#d7dae0",
        cursorAccent: "#1c1f26",
        selectionBackground: "rgba(108, 140, 255, 0.30)",
        black: "#000000",
        red: "#cd3131",
        green: "#0dbc79",
        yellow: "#e5e510",
        blue: "#2472c8",
        magenta: "#bc3fbc",
        cyan: "#11a8cd",
        white: "#e5e5e5",
        brightBlack: "#666666",
        brightRed: "#f14c4c",
        brightGreen: "#23d18b",
        brightYellow: "#f5f543",
        brightBlue: "#3b8eea",
        brightMagenta: "#d670d6",
        brightCyan: "#29b8db",
        brightWhite: "#e5e5e5",
      }
    : {
        background: "#ffffff",
        foreground: "#24292f",
        cursor: "#24292f",
        cursorAccent: "#ffffff",
        selectionBackground: "rgba(79, 110, 242, 0.25)",
        black: "#000000",
        red: "#cd3131",
        green: "#107c10",
        yellow: "#949800",
        blue: "#0451a5",
        magenta: "#bc05bc",
        cyan: "#0598bc",
        white: "#555555",
        brightBlack: "#666666",
        brightRed: "#cd3131",
        brightGreen: "#14ce14",
        brightYellow: "#b5ba00",
        brightBlue: "#0451a5",
        brightMagenta: "#bc05bc",
        brightCyan: "#0598bc",
        brightWhite: "#a5a5a5",
      };
}

/** A promise together with the handle that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * One shell per pane, spawned in the workspace root. The component stays
 * mounted while the panel is merely hidden, so the shell session survives
 * toggling the panel; it is killed on unmount and on window close (Rust side).
 *
 * `initialCommand` is typed into the shell once it is up — the pane is then a
 * normal terminal, so interactive CLIs keep talking to the user directly.
 * `onOutput` receives the same text the terminal shows (task runs read the
 * command's result from it).
 */
export function TerminalPane({
  initialCommand,
  cwd,
  onOutput,
}: {
  initialCommand?: string;
  /** Where the shell starts; the project root when the tab named nowhere else. */
  cwd?: string;
  onOutput?: (chunk: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const rootPath = useWorkspace((s) => s.rootPath);
  const theme = useTheme((s) => s.theme);
  // Read once: re-running the command on a theme change or a re-render would
  // surprise the user, and the prop never changes for a given tab.
  const initialCommandRef = useRef(initialCommand);
  // Kept in a ref so a new callback identity never restarts the shell.
  const onOutputRef = useRef(onOutput);
  useEffect(() => {
    onOutputRef.current = onOutput;
  }, [onOutput]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !rootPath) return;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      // A caret marks a position; it does not need to cover the cell to do it.
      // Measured against VS Code before choosing: its block is one cell, and at
      // its default 14px that is 7.7x16.5 against our 7.15x15.33 - so this is
      // not about size but about weight, and a solid block is the heaviest mark
      // on the screen. A bar is also what Windows Terminal opens with.
      cursorStyle: "bar",
      cursorWidth: 2,
      // Off, as in VS Code (`terminal.integrated.cursorBlinking` defaults to
      // false): a caret that pulses is movement in the corner of the eye all
      // day, and the shell can still ask for blink through DECSCUSR.
      cursorBlink: false,
      theme: xtermThemeOf(useTheme.getState().theme),
      // Auto-adjusts ANY output color (incl. PSReadLine's own RGB colors)
      // to stay readable against the background — critical on light theme.
      // 4.5 is also VS Code's `terminal.integrated.minimumContrastRatio`.
      minimumContrastRatio: 4.5,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;

    let termId: number | null = null;
    const cleanups: (() => void)[] = [];
    const sized = deferred();
    // Everything below can be in flight when the pane goes away; this is the
    // one signal that says so, and it survives an await where a boolean does
    // not (the compiler cannot see a closure reassign one).
    const closed = new AbortController();
    /** Asked, never remembered: an awaited answer goes stale in a variable. */
    const paneIsGone = () => closed.signal.aborted;

    const connect = async () => {
      // The pane is laid out by a parent panel whose effects run after this
      // component's, so the box is still 0x0 right now. A shell spawned here
      // is told it has xterm's 12x6 fallback grid, prints its first prompt
      // into twelve columns, and is then resized out from under that prompt —
      // measured, and the reason the first terminal of a session came up blank.
      await sized.promise;
      if (paneIsGone()) return;

      // The shell starts talking the instant it is spawned, and a Tauri event
      // with no listener yet is dropped, not queued. A warm PowerShell prints
      // its whole prompt within milliseconds of term_create returning — before
      // a listener registered afterwards exists — and then sits silent, which
      // painted the terminal blank on every reopen of a busy workspace. So:
      // listen first, hold what arrives until the id is known, then replay.
      let id: number | null = null;
      const backlog: TermDataPayload[] = [];
      // One decoder per pane: multibyte characters may straddle two chunks.
      const decoder = new TextDecoder();
      const deliver = (payload: TermDataPayload) => {
        const bytes = new Uint8Array(payload.data);
        term.write(bytes);
        onOutputRef.current?.(decoder.decode(bytes, { stream: true }));
      };
      cleanups.push(
        await listen<TermDataPayload>("term:data", ({ payload }) => {
          if (id === null) {
            backlog.push(payload);
            return;
          }
          if (payload.term_id === id) deliver(payload);
        }),
        await listen<TermExitPayload>("term:exit", ({ payload }) => {
          if (payload.term_id === id) term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
        }),
      );

      const created = await invoke<number>("term_create", {
        cwd: cwd ?? rootPath,
        cols: term.cols,
        rows: term.rows,
      });
      // The pane may have gone away while term_create was in flight.
      if (paneIsGone()) {
        await invoke("term_kill", { termId: created });
        return;
      }
      termId = created;
      id = created;
      // Replayed synchronously right after the id lands, so nothing the live
      // listener delivers from here on can slip in front of the backlog.
      backlog.filter((payload) => payload.term_id === created).forEach(deliver);
      backlog.length = 0;
      const input = term.onData((data) => {
        void invoke("term_write", { termId: created, data });
      });
      cleanups.push(() => {
        input.dispose();
      });
      // The shell buffers stdin, so this is safe before the first prompt paints.
      const command = initialCommandRef.current;
      if (command) await invoke("term_write", { termId: created, data: `${command}\r` });
    };
    connect().catch((err: unknown) => {
      term.write(`\x1b[31mFailed to start shell: ${String(err)}\x1b[0m\r\n`);
    });

    // Fires once on observe() and on every size change after (panel drag,
    // expand from the rail) — which is also how the shell learns it may start.
    const observer = new ResizeObserver(() => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      fit.fit();
      sized.resolve();
      if (termId !== null) {
        void invoke("term_resize", { termId, cols: term.cols, rows: term.rows });
      }
    });
    observer.observe(container);

    return () => {
      closed.abort();
      observer.disconnect();
      cleanups.forEach((dispose) => {
        dispose();
      });
      const shell = termId;
      if (shell !== null) {
        invoke("term_kill", { termId: shell }).catch((err: unknown) => {
          // The pane is going away, so there is nowhere left to show this —
          // but a shell that outlives its tab is worth a line in the log.
          console.error("[terminal] could not kill shell", shell, err);
        });
      }
      term.dispose();
      termRef.current = null;
    };
    // `cwd` is fixed for the life of a tab, so it never restarts a shell here.
  }, [rootPath, cwd]);

  // Follow app theme switches live.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermThemeOf(theme);
  }, [theme]);

  return <div ref={containerRef} className="h-full w-full bg-panel py-1 pl-2" />;
}
