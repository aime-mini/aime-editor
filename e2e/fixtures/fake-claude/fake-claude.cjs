/**
 * A stand-in for the `claude` CLI, put first on PATH by `wdio.fake-claude.cjs`.
 *
 * Built-in CLIs are the only ones whose events carry tool calls, subagents,
 * background tasks and API retries; a `providers.json` CLI can only print text.
 * So the chat panel's handling of those needs `claude` itself - and a real turn
 * costs money and cannot be made to fail on cue. Every line written here has
 * the shape of a line captured from Claude Code 2.1.286: a
 * background Agent run, and a run with ANTHROPIC_BASE_URL on a closed port.
 *
 * The spec picks the scenario by writing `mode.txt` into the state folder named
 * by AIME_FAKE_CLAUDE_STATE, and reads back `calls.jsonl` - the arguments and
 * prompt of every turn - and `steered.jsonl`, each message taken up during a
 * turn. The folder lives outside the repository: a file written inside it
 * makes Vite reload the page under test.
 */
const fs = require("node:fs");
const path = require("node:path");

const state = process.env.AIME_FAKE_CLAUDE_STATE ?? "";
const args = process.argv.slice(2);

/** What the health probes ask before any turn. */
const PROBES = {
  "--version": () => console.log("2.1.286 (Claude Code)"),
  auth: () => console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })),
};

const emit = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const record = (file, entry) => fs.appendFileSync(path.join(state, file), `${JSON.stringify(entry)}\n`);

/** Messages handed over during the turn, not yet taken up - what the real CLI holds on its stdin. */
const handed = [];

/**
 * Answers a request to take back a handed message the way 2.1.310 does
 * (`cancel_async_message`): taken back while it waits, refused once read.
 */
function withdraw({ request_id, request }) {
  const at = handed.findIndex((message) => message.uuid === request.message_uuid);
  if (at !== -1) {
    record("withdrawn.jsonl", { text: handed[at].text });
    handed.splice(at, 1);
  }
  emit({
    type: "control_response",
    response: { subtype: "success", request_id, response: { cancelled: at !== -1 } },
  });
}

/**
 * A chat turn speaks stream-json on stdin (`--input-format stream-json`): the
 * prompt is the first user line, and each later line is a message handed
 * over while the turn runs, or a request to take one back. Resolves to the
 * prompt; the rest queue in `handed` until a scenario takes them up where the
 * real CLI does.
 */
function readStreamJson() {
  return new Promise((resolve) => {
    let pending = "";
    let prompt = null;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.type === "control_request") {
          withdraw(message);
          continue;
        }
        const text = message.message.content;
        if (prompt === null) {
          prompt = text;
          // Echoed as it is read, as 2.1.309 does with `--replay-user-messages`:
          // the app closes the input only once every message it wrote came back.
          emit({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
          resolve(text);
        } else {
          handed.push({ text, uuid: message.uuid });
        }
      }
    });
  });
}

/**
 * Takes up what was handed over, the way 2.1.307 does at a step boundary:
 * each message is echoed back as a user line (`--replay-user-messages`), with
 * the id it was handed with, and is from then on part of the turn.
 */
function takeUp() {
  for (const { text, uuid } of handed.splice(0)) {
    emit({ type: "user", uuid, message: { role: "user", content: text }, parent_tool_use_id: null });
    record("steered.jsonl", { text });
  }
}

function turn(session) {
  const say = (text) =>
    emit({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
    });
  const tool = (id, name, input, parent = null) =>
    emit({
      type: "assistant",
      message: { content: [{ type: "tool_use", id, name, input }] },
      parent_tool_use_id: parent,
    });
  const system = (subtype, fields) => emit({ type: "system", subtype, session_id: session, ...fields });
  const result = (index, sessionCost, fields = {}) =>
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      total_cost_usd: sessionCost,
      duration_ms: 900,
      session_id: session,
      result_index: index,
      usage: { input_tokens: 10, output_tokens: 5 },
      ...fields,
    });
  system("init", { model: "claude-haiku-4-5" });
  return { say, tool, system, result };
}

/** What the `server` scenario says it left running. */
const SERVER_TASK = "Start the dev server on port 5173";
const AGENT_CALL = "toolu_agent_review";
const AGENT_BRIEF = "Independent review of the diff";
const AGENT_STEPS = 12;
const AGENT_STEP_MS = 700;
const INVESTIGATION_STEPS = 14;
const RETRIES_SHOWN = 3;
const RETRY_MS = 1500;
const LIVE_COMMAND = "sleep 3 && echo hi";
const LIVE_COMMAND_MS = 3000;
const LIVE_THINKING_MS = 1200;
const LIVE_FILE = "C:\\work\\docs\\rivers.md";
const LIVE_FILE_LINES = 120;
const LIVE_ANSWER_LINES = 150;
const LIVE_LINE_MS = 80;
const SLOW_COMMAND = "sleep 10";
const SLOW_COMMAND_MS = 10_000;

/** What a flow's AI step says: JSON when asked for one, else prose the executor reads. */
function stepAnswer(prompt) {
  return prompt.includes("Reply with one JSON value")
    ? JSON.stringify({ files: ["README.md", "hello.ts"], count: 2 })
    : [
        "Looked at the project and wrote the note.",
        "",
        "SUMMARY: wrote notes/flow.md",
        "FILE: notes/flow.md",
      ].join("\n");
}

/** A flow drawn from a sentence: files, counted. */
/**
 * A step as a strict schema has the model write it (`lib/flows/compilerSchemas.ts`):
 * every key present, the config as JSON text, the keys left to their default null.
 */
const wireStep = (id, name, does, ability, config) => ({
  id,
  name,
  does,
  ability,
  config: JSON.stringify(config),
  onError: null,
  retries: null,
  forEach: null,
});

const DRAWN_FLOW = {
  name: "Count the files",
  description: "Lists the files of the project and counts them.",
  hints: [],
  steps: [
    wireStep("input", "Input", "", "input", {}),
    wireStep("list", "List the files", "", "files", { globs: ["*"] }),
    wireStep("count", "Count them", "How many files there are", "transform", {
      program: ".list.value | length",
    }),
  ],
  wires: [
    { from: "input", port: "out", to: "list", maxRounds: null },
    { from: "list", port: "out", to: "count", maxRounds: null },
  ],
};

/** The compiler's answers (`lib/flows/compiler.ts`), or null for a step's turn. */
function compilerAnswer(prompt) {
  if (prompt.startsWith("Draw a flow")) return JSON.stringify(DRAWN_FLOW);
  if (prompt.startsWith("Change the flow")) {
    const asIs = JSON.parse(prompt.split("## The flow as it is\n\n")[1].split("\n\n## The request")[0]);
    return JSON.stringify({
      ...asIs,
      steps: [
        ...asIs.steps,
        wireStep("tell", "Tell me", "Say how many there are", "ai", { permission: "readOnly" }),
      ],
      wires: [...asIs.wires, { from: asIs.steps.at(-1).id, port: "out", to: "tell", maxRounds: null }],
    });
  }
  if (prompt.startsWith("Write the config of a")) {
    const ability = prompt.slice('Write the config of a "'.length).split('"')[0];
    const configs = {
      transform: { program: ".read.value.count" },
      gate: { branches: [{ label: "yes", program: "true" }] },
      command: {
        command: {
          all: [{ program: "node", args: ["-e", "console.log('ok')"] }],
          windows: null,
          macos: null,
          linux: null,
        },
        cwd: null,
      },
      http: { method: "GET", url: "https://example.invalid/", headers: null, body: null, parse: "text" },
    };
    return JSON.stringify(configs[ability]);
  }
  if (prompt.startsWith("A step of a flow failed")) {
    return JSON.stringify({
      explanation: "The program exits with 1 on purpose. Make it print instead.",
      change: JSON.stringify({
        command: { all: [{ program: "node", args: ["-e", "console.log('fixed')"] }] },
      }),
    });
  }
  return null;
}

const SCENARIOS = {
  /**
   * A dev server left running in the background: the
   * answer ends, the process lives on with the server, and the next message
   * written to it is answered right away - the way 2.1.309 does it. Nothing
   * ends the server, so the process lasts until it is stopped.
   */
  /**
   * One long command, and what was handed over during it taken up after it:
   * time enough to write a message and take it back while the AI is busy.
   */
  async slow({ say, tool, result }) {
    tool("toolu_slow_bash", "Bash", { command: SLOW_COMMAND, description: "Wait a while" });
    await pause(SLOW_COMMAND_MS);
    takeUp();
    say("Done waiting.");
    result(0, 0.05);
  },

  async server({ say, system, result }) {
    system("background_tasks_changed", {
      tasks: [{ task_id: "s1", task_type: "local_bash", description: SERVER_TASK }],
    });
    say("The server is running.");
    result(0, 0.1);
    while (handed.length === 0) await pause(50);
    takeUp();
    say("Yes, it answers on port 5173.");
    result(1, 0.2);
  },

  /** An Agent sent to the background: the answer ends, its subagent keeps working. */
  async agent({ say, tool, system, result }) {
    tool(AGENT_CALL, "Agent", { description: AGENT_BRIEF, prompt: "Review it.", run_in_background: true });
    system("background_tasks_changed", {
      tasks: [{ task_id: "a1", task_type: "local_agent", description: AGENT_BRIEF }],
    });
    system("task_started", {
      task_id: "a1",
      tool_use_id: AGENT_CALL,
      description: AGENT_BRIEF,
      is_backgrounded: true,
    });
    say("Started the review in the background.");
    for (let step = 1; step <= AGENT_STEPS; step += 1) {
      await pause(AGENT_STEP_MS);
      tool(`toolu_sub_${step}`, "Bash", { command: `grep -n "step${step}" src/file${step}.ts` }, AGENT_CALL);
    }
    system("background_tasks_changed", { tasks: [] });
    say(" The review is done.");
    // Two answers in one process, each reporting the session's running total.
    result(0, 0.4);
    result(1, 0.5);
  },

  /** An investigation: one command after another, then the answer. */
  async tools({ say, tool, result }) {
    for (let step = 1; step <= INVESTIGATION_STEPS; step += 1) {
      const reads = step % 5 === 0;
      tool(
        `toolu_main_${step}`,
        reads ? "Read" : "Bash",
        reads ? { file_path: `src/f${step}.ts` } : { command: `cat src/f${step}.ts` },
      );
      await pause(80);
    }
    say("Checked every file.");
    result(0, 0.6);
  },

  /** The AI service cannot be reached: the CLI retries, then gives up and exits 1. */
  async network({ system, result }) {
    for (let attempt = 1; attempt <= RETRIES_SHOWN; attempt += 1) {
      system("api_retry", {
        attempt,
        max_retries: 10,
        retry_delay_ms: RETRY_MS,
        error_status: null,
        error: "unknown",
      });
      await pause(RETRY_MS);
    }
    result(0, 0.6, {
      is_error: true,
      terminal_reason: "api_error",
      result: "API Error: Connection refused - a firewall or proxy may be blocking it (ECONNREFUSED)",
    });
    process.exitCode = 1;
  },

  /**
   * Reading a repository for its tasks: first a build command the project does
   * not have, then - shown it failing - the right one. A real CLI puts its
   * answer in the result, which is where Aime reads it.
   */
  async tasks({ say, result }, prompt) {
    const command = prompt.includes("were run here and failed") ? "node build.cjs" : "node build.cjs --wrong";
    const answer = JSON.stringify({
      tasks: [{ kind: "build", label: "node build.cjs", command, dir: ".", source: "README.md" }],
    });
    say(answer);
    result(0, 0, { result: answer });
  },

  /**
   * Learning a project in the background: the whole names two parts, `lib`
   * answers at once, and `api` first answers in prose - the way a model that
   * ignored the format does - then, told so, with the JSON.
   */
  async learn({ say, result }, prompt) {
    const memory = (name, scope, summary, files) => ({
      name,
      kind: "structure",
      scope,
      summary,
      files,
      body: "",
    });
    const studying = (scope) => prompt.includes(`Study one part of this project: \`${scope}\``);
    let answer;
    if (prompt.includes("Study the project as a whole")) {
      answer = {
        memories: [memory("project-overview", "/", "A greeting library with an api package", ["hello.ts"])],
        parts: ["lib", "api"],
      };
    } else if (studying("lib")) {
      answer = {
        memories: [memory("lib-router", "lib", "lib routes requests to handlers", ["lib/router.js"])],
      };
    } else if (studying("api") && prompt.includes("could not be used")) {
      answer = {
        memories: [memory("api-package", "api", "api is the package its tests run in", ["api/package.json"])],
      };
    } else {
      answer = "The api folder holds a package with one test script.";
    }
    const text = typeof answer === "string" ? answer : JSON.stringify(answer);
    say(text);
    result(0, 0, { result: text });
  },

  /**
   * A turn as it is written, in the line shapes captured from 2.1.302:
   * a command that takes a while, a file whose content streams
   * as the call's input for seconds, then an answer long enough to scroll.
   */
  async live({ say, system, result }) {
    const stream = (event) => emit({ type: "stream_event", event, parent_tool_use_id: null });
    const call = async (index, id, name, input, chunkChars, chunkMs) => {
      stream({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id, name, input: {} },
      });
      const json = JSON.stringify(input);
      for (let at = 0; at < json.length; at += chunkChars) {
        stream({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: json.slice(at, at + chunkChars) },
        });
        await pause(chunkMs);
      }
      emit({
        type: "assistant",
        message: { content: [{ type: "tool_use", id, name, input }] },
        parent_tool_use_id: null,
      });
      stream({ type: "content_block_stop", index });
    };
    const answered = (id) =>
      emit({
        type: "user",
        message: {
          role: "user",
          content: [{ tool_use_id: id, type: "tool_result", content: "ok", is_error: false }],
        },
        parent_tool_use_id: null,
      });

    system("status", { status: "requesting" });
    await call(
      0,
      "toolu_live_bash",
      "Bash",
      { command: LIVE_COMMAND, description: "Wait, then greet" },
      20,
      40,
    );
    await pause(LIVE_COMMAND_MS);
    answered("toolu_live_bash");
    takeUp();
    system("status", { status: "requesting" });
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });
    await pause(LIVE_THINKING_MS);
    const poem = Array.from(
      { length: LIVE_FILE_LINES },
      (_, line) => `Line ${line + 1} of a river that keeps going`,
    );
    await call(1, "toolu_live_write", "Write", { file_path: LIVE_FILE, content: poem.join("\n") }, 60, 40);
    answered("toolu_live_write");
    takeUp();
    system("status", { status: "requesting" });
    for (let line = 1; line <= LIVE_ANSWER_LINES; line += 1) {
      say(`Paragraph ${line} of the answer, long enough to wrap a little in a narrow panel.\n\n`);
      await pause(LIVE_LINE_MS);
    }
    result(0, 0.3);
  },

  /**
   * The AI's turns in a flow: a step (`lib/flows/executors.ts`) answers JSON
   * when the step asks for it, else prose with the SUMMARY and FILE lines the
   * executor reads; the compiler (`lib/flows/compiler.ts`) is told apart by
   * the first line of its prompt and answers the JSON its schema asks for.
   */
  async flow({ say, result }, prompt) {
    const answer = compilerAnswer(prompt) ?? stepAnswer(prompt);
    say(answer);
    result(0, 0.02, { result: answer });
  },

  /** The turn that picks an interrupted one up. */
  async resume({ say, result }) {
    say(args.includes("--resume") ? "Picked up where it stopped." : "Started over without the session.");
    result(0, 0.7);
  },

  /**
   * A turn the CLI compacted on its way to answering - the line shapes of
   * `/compact` on 2.1.287: a status, the boundary with what it dropped, then
   * the answer as usual.
   */
  async compact({ say, system, result }) {
    system("status", { status: "compacting" });
    system("status", { status: null, compact_result: "success" });
    system("compact_boundary", {
      compact_metadata: { trigger: "auto", pre_tokens: 150_000, post_tokens: 2_000 },
    });
    say("Compacted, then answered.");
    result(0, 0.8);
  },
};

async function main() {
  const probe = PROBES[args[0]];
  if (probe) return probe();
  const modeFile = path.join(state, "mode.txt");
  // Anything else the app asks of `claude` (MCP list, a one-shot) gets silence.
  if (!args.includes("-p") || !fs.existsSync(modeFile)) return;

  // A chat turn converses over stream-json; a one-shot still hands plain text.
  const prompt = args.includes("--input-format") ? await readStreamJson() : fs.readFileSync(0, "utf8");
  const mode = fs.readFileSync(modeFile, "utf8").trim();
  record("calls.jsonl", { mode, args, prompt });
  const resumeAt = args.indexOf("--resume");
  await SCENARIOS[mode](turn(resumeAt === -1 ? "fake-session-1" : args[resumeAt + 1]), prompt);
  // Like the real CLI, a conversing turn ends when its input is closed - which
  // the app does at the result; a prompt that still has stdin open would hang
  // here, and that is the check.
}

void main();
