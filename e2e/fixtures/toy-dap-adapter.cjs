/**
 * A real DAP adapter, for a language Aime does not ship one for.
 *
 * It exists to prove **Aime's** side of a taught adapter: that an entry in
 * `.aime/debug-adapters.json` is read, that a language Aime never heard of
 * becomes debuggable through it, that nothing is believed until Aime has watched
 * a session stop, and that the stamp is written afterwards. It speaks the
 * protocol properly — `Content-Length` framing, the handshake in the documented
 * order, one thread, one frame — and it does so over whatever stream it is
 * handed: this file's own stdio, or the socket the language-server fixture next
 * door publishes. What it does not do is run a program: the "stop" is announced
 * on the line it was asked to break on.
 *
 * Nothing in the app knows this file is a toy, which is exactly the point.
 */

/**
 * One DAP conversation, writing through `send`.
 *
 * A closure rather than module state so the same state machine serves both
 * transports — two copies of a protocol in a fixture is two chances to test the
 * wrong thing.
 */
function createSession(send) {
  let seq = 0;
  /** The program the launch request named, echoed back as the frame's source. */
  let program = "";
  let breakpointLine = 1;

  const write = (message) => {
    const body = JSON.stringify({ seq: ++seq, ...message });
    send(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  const respond = (request, body) => {
    write({ type: "response", request_seq: request.seq, command: request.command, success: true, body });
  };
  const event = (name, body) => {
    write({ type: "event", event: name, body });
  };

  return function handle(request) {
    switch (request.command) {
      case "initialize":
        respond(request, { supportsConfigurationDoneRequest: true });
        // The client waits for this before it sends breakpoints.
        event("initialized", {});
        return;

      case "setBreakpoints": {
        const lines = request.arguments?.breakpoints ?? [];
        breakpointLine = lines[0]?.line ?? 1;
        respond(request, { breakpoints: lines.map((entry) => ({ verified: true, line: entry.line })) });
        return;
      }

      case "launch":
      case "attach":
        program = request.arguments?.program ?? "";
        // Printed back so a test can see exactly what the client sent - a
        // fixture that hides its input can only prove half of anything.
        event("output", {
          category: "console",
          output: `launched with ${JSON.stringify(request.arguments)}\n`,
        });
        respond(request, {});
        return;

      case "configurationDone":
        respond(request, {});
        // Only now is the client ready to be told where execution stopped.
        event("stopped", { reason: "breakpoint", threadId: 1, allThreadsStopped: true });
        return;

      case "threads":
        respond(request, { threads: [{ id: 1, name: "main" }] });
        return;

      case "stackTrace":
        respond(request, {
          stackFrames: [
            {
              id: 1,
              name: "main",
              line: breakpointLine,
              column: 1,
              source: { name: program.split(/[\\/]/).pop(), path: program },
            },
          ],
          totalFrames: 1,
        });
        return;

      case "scopes":
        respond(request, { scopes: [{ name: "Locals", variablesReference: 2, expensive: false }] });
        return;

      case "variables":
        respond(request, { variables: [{ name: "answer", value: "42", variablesReference: 0 }] });
        return;

      case "continue":
        respond(request, { allThreadsContinued: true });
        event("terminated", {});
        return;

      case "disconnect":
        respond(request, {});
        event("terminated", {});
        setTimeout(() => process.exit(0), 10);
        return;

      default:
        respond(request, {});
    }
  };
}

/** Feeds framed messages out of a byte stream into a handler. */
function createReader(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const header = buffer.indexOf("\r\n\r\n");
      if (header === -1) return;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, header).toString())?.[1]);
      if (!Number.isFinite(length) || buffer.length < header + 4 + length) return;
      const raw = buffer.subarray(header + 4, header + 4 + length).toString();
      buffer = buffer.subarray(header + 4 + length);
      try {
        onMessage(JSON.parse(raw));
      } catch {
        /* a malformed frame is not worth dying over */
      }
    }
  };
}

module.exports = { createSession, createReader };

// Started directly: the stdio transport, which is what an entry with
// `"transport": "stdio"` launches.
if (require.main === module) {
  const handle = createSession((text) => process.stdout.write(text));
  process.stdin.on(
    "data",
    createReader((message) => {
      if (message.type === "request") handle(message);
    }),
  );
}
