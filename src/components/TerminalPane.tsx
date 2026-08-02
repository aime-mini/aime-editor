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
 * xterm palette matching the app palettes in index.css. The 16 ANSI colors
 * must be set per theme too — xterm's built-in ANSI palette targets dark
 * backgrounds, so on a light background yellow/white output is unreadable.
 */
function xtermThemeOf(theme: Theme): ITheme {
  return theme === "dark"
    ? {
        background: "#1c1f26",
        foreground: "#d7dae0",
        cursor: "#6c8cff",
        selectionBackground: "rgba(108, 140, 255, 0.30)",
        black: "#23272f",
        red: "#e5534b",
        green: "#57ab5a",
        yellow: "#c69026",
        blue: "#6c8cff",
        magenta: "#b083f0",
        cyan: "#39c5cf",
        white: "#8b919d",
        brightBlack: "#545d68",
        brightRed: "#f47067",
        brightGreen: "#6bc46d",
        brightYellow: "#daaa3f",
        brightBlue: "#8cb0ff",
        brightMagenta: "#c8a1f7",
        brightCyan: "#56d4dd",
        brightWhite: "#d7dae0",
      }
    : {
        background: "#ffffff",
        foreground: "#24292f",
        cursor: "#4f6ef2",
        selectionBackground: "rgba(79, 110, 242, 0.25)",
        black: "#24292f",
        red: "#cf222e",
        green: "#1a7f37",
        yellow: "#9a6700",
        blue: "#0969da",
        magenta: "#8250df",
        cyan: "#1b7c83",
        white: "#6e7781",
        brightBlack: "#57606a",
        brightRed: "#a40e26",
        brightGreen: "#2da44e",
        brightYellow: "#bf8700",
        brightBlue: "#218bff",
        brightMagenta: "#a475f9",
        brightCyan: "#3192aa",
        brightWhite: "#57606a",
      };
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
  onOutput,
}: {
  initialCommand?: string;
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
      cursorBlink: true,
      theme: xtermThemeOf(useTheme.getState().theme),
      // Auto-adjusts ANY output color (incl. PSReadLine's own RGB colors)
      // to stay readable against the background — critical on light theme.
      minimumContrastRatio: 4.5,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;

    let termId: number | null = null;
    let disposed = false;
    const cleanups: (() => void)[] = [];

    const connect = async () => {
      const id = await invoke<number>("term_create", {
        cwd: rootPath,
        cols: term.cols,
        rows: term.rows,
      });
      // The effect may have been cleaned up while term_create was in flight.
      if (disposed) {
        await invoke("term_kill", { termId: id });
        return;
      }
      termId = id;
      // One decoder per pane: multibyte characters may straddle two chunks.
      const decoder = new TextDecoder();
      cleanups.push(
        await listen<TermDataPayload>("term:data", ({ payload }) => {
          if (payload.term_id !== id) return;
          const bytes = new Uint8Array(payload.data);
          term.write(bytes);
          onOutputRef.current?.(decoder.decode(bytes, { stream: true }));
        }),
        await listen<TermExitPayload>("term:exit", ({ payload }) => {
          if (payload.term_id === id) term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
        }),
      );
      const input = term.onData((data) => {
        void invoke("term_write", { termId: id, data });
      });
      cleanups.push(() => {
        input.dispose();
      });
      // The shell buffers stdin, so this is safe before the first prompt paints.
      const command = initialCommandRef.current;
      if (command) await invoke("term_write", { termId: id, data: `${command}\r` });
    };
    connect().catch((err: unknown) => {
      term.write(`\x1b[31mFailed to start shell: ${String(err)}\x1b[0m\r\n`);
    });

    // Refit on any container size change (panel drag, expand from the rail).
    const observer = new ResizeObserver(() => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      fit.fit();
      if (termId !== null) {
        void invoke("term_resize", { termId, cols: term.cols, rows: term.rows });
      }
    });
    observer.observe(container);

    return () => {
      disposed = true;
      observer.disconnect();
      cleanups.forEach((dispose) => {
        dispose();
      });
      if (termId !== null) void invoke("term_kill", { termId });
      term.dispose();
      termRef.current = null;
    };
  }, [rootPath]);

  // Follow app theme switches live.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermThemeOf(theme);
  }, [theme]);

  return <div ref={containerRef} className="h-full w-full bg-panel py-1 pl-2" />;
}
