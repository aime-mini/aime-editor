/**
 * The headless command runner, end to end: the real webview calling the real
 * Rust command, spawning a real process, in a real folder.
 *
 * Everything downstream of this — the regression gate, and the run that stops
 * on it — believes what a command's exit code says. So the things proved here
 * are the ones that would make the whole chain lie: that the code is the
 * process's own and not something parsed out of its output, that the two
 * streams stay apart, that a deadline actually ends a command instead of
 * waiting it out, and that the answer arrives over the wire in the shape the
 * frontend expects.
 *
 * The sample project is created by this spec and thrown away with it. Nothing
 * here touches a real repository.
 */
const { strict: assert } = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Calls a Tauri command from inside the window. `browser.execute` does not
 * await a promise, so the answer lands on a window flag that `waitUntil` reads.
 */
async function invoke(command, payload) {
  await browser.execute(
    (cmd, args) => {
      window.__aimeExec = undefined;
      window.__TAURI_INTERNALS__.invoke(cmd, args).then(
        (value) => (window.__aimeExec = { ok: true, value }),
        (error) => (window.__aimeExec = { ok: false, error: String(error) }),
      );
    },
    command,
    payload,
  );
  await browser.waitUntil(async () => browser.execute(() => window.__aimeExec !== undefined), {
    timeout: 120_000,
    timeoutMsg: `${command} never answered`,
  });
  const answer = await browser.execute(() => window.__aimeExec);
  assert.ok(answer.ok, `${command} failed: ${answer.error}`);
  return answer.value;
}

/** Starts a command without waiting, so the test can cancel it mid-flight. */
async function invokeDetached(payload) {
  await browser.execute((args) => {
    // A flag of its own: the cancel that follows goes through invoke(), which
    // clears the shared one, and the run's answer would be lost with it.
    window.__aimeDetached = undefined;
    window.__TAURI_INTERNALS__.invoke("exec_run", args).then(
      (value) => (window.__aimeDetached = { ok: true, value }),
      (error) => (window.__aimeDetached = { ok: false, error: String(error) }),
    );
  }, payload);
}

async function detachedAnswer() {
  await browser.waitUntil(async () => browser.execute(() => window.__aimeDetached !== undefined), {
    timeout: 120_000,
    timeoutMsg: "the detached command never answered",
  });
  const answer = await browser.execute(() => window.__aimeDetached);
  assert.ok(answer.ok, `exec_run failed: ${answer.error}`);
  return answer.value;
}

/** A command that sleeps, spelled for whichever shell Rust will use. */
const sleepFor = (seconds) =>
  process.platform === "win32" ? `ping -n ${seconds + 1} 127.0.0.1 > nul` : `sleep ${seconds}`;

describe("Headless command runner", () => {
  let sample = "";

  before(async () => {
    // A sample project of its own, with nothing installed and nothing to
    // install: this spec is about the runner, not about any test framework.
    sample = fs.mkdtempSync(path.join(os.tmpdir(), "aime-exec-"));
    fs.writeFileSync(path.join(sample, "readme.md"), "# sample\n");
    await browser.waitUntil(async () => (await $("body").getText()).length > 0, {
      timeout: 30_000,
      timeoutMsg: "the window never rendered",
    });
  });

  after(() => {
    try {
      fs.rmSync(sample, { recursive: true, force: true });
    } catch {
      // Windows may still hold the folder; the temp sweep gets it.
    }
  });

  it("answers with the process's own exit code, not with anything it printed", async () => {
    const ok = await invoke("exec_run", { id: "e2e-ok", command: "echo hello", cwd: sample, timeoutMs: 30_000 });
    assert.equal(ok.code, 0, `expected success, got ${JSON.stringify(ok)}`);
    assert.match(ok.stdout, /hello/);

    const failed = await invoke("exec_run", { id: "e2e-fail", command: "exit 7", cwd: sample, timeoutMs: 30_000 });
    assert.equal(failed.code, 7, "the exit code must come from the process");
    assert.equal(
      failed.stdout.includes("7"),
      false,
      `nothing was printed to read the code from, so it came from the process: ${failed.stdout}`,
    );
  });

  it("hands back the shape the frontend expects, in camelCase", async () => {
    const outcome = await invoke("exec_run", {
      id: "e2e-shape",
      command: "echo shape",
      cwd: sample,
      timeoutMs: 30_000,
    });
    assert.deepEqual(
      Object.keys(outcome).sort(),
      ["cancelled", "clipped", "code", "durationMs", "stderr", "stdout", "timedOut"],
      `the wire shape changed: ${JSON.stringify(outcome)}`,
    );
    assert.equal(typeof outcome.durationMs, "number");
  });

  it("keeps the two streams apart, because a report can be split across them", async () => {
    const outcome = await invoke("exec_run", {
      id: "e2e-streams",
      command: "echo answer && echo complaint 1>&2",
      cwd: sample,
      timeoutMs: 30_000,
    });
    assert.match(outcome.stdout, /answer/);
    assert.doesNotMatch(outcome.stdout, /complaint/);
    assert.match(outcome.stderr, /complaint/);
  });

  it("ends a command that outstays its deadline, instead of waiting it out", async () => {
    // The failure this guards against was measured: killing the shell left the
    // program it started holding the pipes, so a 300 ms deadline returned after
    // 61 s. A deadline that can be outwaited is not a deadline.
    const started = Date.now();
    const outcome = await invoke("exec_run", {
      id: "e2e-timeout",
      command: sleepFor(60),
      cwd: sample,
      timeoutMs: 1_000,
    });
    const waited = Date.now() - started;

    assert.equal(outcome.timedOut, true, "the deadline did not fire");
    assert.equal(outcome.cancelled, false, "a deadline is not a cancel");
    assert.equal(outcome.code, null, "a killed process has no exit code to report");
    assert.ok(waited < 30_000, `it waited ${waited} ms for a 1 s deadline`);
  });

  it("can be cancelled while it runs, and says that is what happened", async () => {
    await invokeDetached({ id: "e2e-cancel", command: sleepFor(60), cwd: sample, timeoutMs: 120_000 });
    // Give it a moment to actually be running before pulling the handle.
    await browser.pause(500);
    const started = Date.now();
    await invoke("exec_cancel", { id: "e2e-cancel" });

    const outcome = await detachedAnswer();
    const waited = Date.now() - started;
    assert.equal(outcome.cancelled, true, "the cancel never reached the process");
    assert.equal(outcome.timedOut, false, "a cancel is not a deadline");
    assert.ok(waited < 30_000, `the cancel took ${waited} ms, so something outlived it`);
  });

  it("streams its output while it runs, so a long job does not look like a hang", async () => {
    await browser.execute(() => {
      window.__aimeExecLines = [];
      window.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
        event: "exec:output",
        target: { kind: "Any" },
        handler: window.__TAURI_INTERNALS__.transformCallback((message) => {
          window.__aimeExecLines.push(message.payload);
        }),
      });
    });

    await invoke("exec_run", {
      id: "e2e-stream",
      command: "echo first && echo second 1>&2",
      cwd: sample,
      timeoutMs: 30_000,
    });

    await browser.waitUntil(
      async () =>
        browser.execute(
          () => (window.__aimeExecLines ?? []).filter((line) => line.id === "e2e-stream").length >= 2,
        ),
      { timeout: 20_000, timeoutMsg: "the output never arrived as events" },
    );
    const lines = await browser.execute(() =>
      (window.__aimeExecLines ?? []).filter((line) => line.id === "e2e-stream"),
    );
    assert.ok(
      lines.some((line) => line.stream === "stdout" && line.line.includes("first")),
      `no stdout event: ${JSON.stringify(lines)}`,
    );
    assert.ok(
      lines.some((line) => line.stream === "stderr" && line.line.includes("second")),
      `no stderr event: ${JSON.stringify(lines)}`,
    );
  });
});
