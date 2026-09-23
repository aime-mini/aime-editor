import { stripAnsi } from "../taskOutput";

/**
 * The moment a program being debugged starts serving, and the address to open.
 *
 * VS Code asks for a `serverReadyAction` pattern in launch.json; Aime reads the
 * program's own output for the one thing every server prints once it listens -
 * its address - so a web project opens in the browser without anyone having to
 * write a pattern first. Measured on this machine:
 *
 * - ASP.NET: `      Now listening on: http://0.0.0.0:5987\r`
 * - Vite:    `  ➜  Local:   http://localhost:\e[1m5991\e[22m/` - the colour codes
 *   sit INSIDE the address, so they come off before anything is matched.
 */

/** A local address with its port and path, as a server announces itself. */
const LOCAL_ADDRESS = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\+|\*)(?::\d+)?[^\s"'<>]*/i;

/**
 * Hosts a server binds to rather than one a browser can visit: "every
 * interface" in the spellings of POSIX, IPv6 and ASP.NET's `+` / `*`.
 */
const ANY_INTERFACE = /^(https?:\/\/)(?:0\.0\.0\.0|\[::\]|\+|\*)/i;

/** The address a browser should open, or null when this output announces none. */
export function servingAddress(output: string): string | null {
  const found = LOCAL_ADDRESS.exec(stripAnsi(output));
  if (found === null) return null;
  // A sentence ending on the address is not part of it.
  const address = found[0].replace(/[.,;:)\]]+$/, "");
  return address.replace(ANY_INTERFACE, "$1localhost");
}

/** How much of an unfinished line is kept waiting for its end; a flood is not a line. */
const PARTIAL_LINE_LIMIT = 4_096;

/**
 * Listens to a session's output and calls `open` once, for the first address
 * a finished line announces.
 *
 * Whole lines only: output arrives in pieces, and a piece that ends at
 * `http://localhost:59` would otherwise open the wrong port before `87` came.
 */
export function watchForServer(open: (address: string) => void): (output: string) => void {
  let partial = "";
  let opened = false;
  return (output) => {
    if (opened) return;
    const lines = (partial + output).split("\n");
    partial = (lines.pop() ?? "").slice(-PARTIAL_LINE_LIMIT);
    for (const line of lines) {
      const address = servingAddress(line);
      if (address !== null) {
        opened = true;
        open(address);
        return;
      }
    }
  };
}
