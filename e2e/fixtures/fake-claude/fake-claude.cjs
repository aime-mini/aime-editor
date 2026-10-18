/**
 * A stand-in for the `claude` CLI, put first on PATH by `wdio.fake-claude.cjs`.
 *
 * Built-in CLIs are the only ones whose events carry tool calls, subagents,
 * background tasks and API retries; a `providers.json` CLI can only print text.
 * So the chat panel's handling of those needs `claude` itself - and a real turn
 * costs money and cannot be made to fail on cue. Every line written here has
 * the shape of a line captured from Claude Code 2.1.286 (2026-10-01): a
 * background Agent run, and a run with ANTHROPIC_BASE_URL on a closed port.
 *
 * The spec picks the scenario by writing `mode.txt` into the state folder named
 * by AIME_FAKE_CLAUDE_STATE, and reads back `calls.jsonl` - the arguments and
 * prompt of every turn. The folder lives outside the repository: a file written
 * inside it makes Vite reload the page under test.
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

const SCENARIOS = {
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
   * A turn as it is written, in the line shapes of 2.1.302 (captured
   * 2026-10-18): a command that takes a while, a file whose content streams
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
    system("status", { status: "requesting" });
    for (let line = 1; line <= LIVE_ANSWER_LINES; line += 1) {
      say(`Paragraph ${line} of the answer, long enough to wrap a little in a narrow panel.\n\n`);
      await pause(LIVE_LINE_MS);
    }
    result(0, 0.3);
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

  const prompt = fs.readFileSync(0, "utf8");
  const mode = fs.readFileSync(modeFile, "utf8").trim();
  fs.appendFileSync(path.join(state, "calls.jsonl"), `${JSON.stringify({ mode, args, prompt })}\n`);
  const resumeAt = args.indexOf("--resume");
  await SCENARIOS[mode](turn(resumeAt === -1 ? "fake-session-1" : args[resumeAt + 1]), prompt);
}

void main();
