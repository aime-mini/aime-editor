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

  /** The turn that picks an interrupted one up. */
  async resume({ say, result }) {
    say(args.includes("--resume") ? "Picked up where it stopped." : "Started over without the session.");
    result(0, 0.7);
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
