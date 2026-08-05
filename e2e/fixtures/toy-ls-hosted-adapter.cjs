/**
 * A language server that hosts a debug adapter — the third transport shape.
 *
 * This is how java-debug actually works: there is no standalone adapter to
 * launch. Aime starts the language server, asks it over LSP to open a debug
 * session (`workspace/executeCommand`), and the server answers with a port to
 * connect to. Everything that shape needs is exercised here — the LSP handshake,
 * the command, the port, and a real DAP conversation on the socket — without
 * downloading several hundred megabytes of Eclipse to find out whether Aime's
 * side of it works.
 *
 * The DAP half is the same state machine the stdio fixture uses, on purpose.
 */
const net = require("node:net");
const { createSession, createReader } = require("./toy-dap-adapter.cjs");

/** The command an entry names in `languageServerCommand`. */
const START_DEBUG_SESSION = "aime.test.startDebugSession";

function write(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/** Opens a DAP server and answers with the port it landed on. */
function startDebugServer() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      const handle = createSession((text) => socket.write(text));
      socket.on(
        "data",
        createReader((message) => {
          if (message.type === "request") handle(message);
        }),
      );
    });
    // Port 0: the operating system picks a free one, which is the only way a
    // fixture can run twice on the same machine.
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address().port);
    });
  });
}

process.stdin.on(
  "data",
  createReader((message) => {
    if (message.method === "initialize") {
      write({
        id: message.id,
        result: { capabilities: { executeCommandProvider: { commands: [START_DEBUG_SESSION] } } },
      });
      return;
    }
    if (message.method === "workspace/executeCommand") {
      if (message.params?.command !== START_DEBUG_SESSION) {
        write({
          id: message.id,
          error: { code: -32601, message: `unknown command ${message.params?.command}` },
        });
        return;
      }
      // A bare number, which is what java-debug answers with.
      void startDebugServer().then((port) => {
        write({ id: message.id, result: port });
      });
      return;
    }
    // `initialized` and anything else a client sends is a notification here.
  }),
);
