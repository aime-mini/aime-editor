/**
 * Flows, end to end on the stand-in CLI: a flow is made in the sidebar, gets
 * its steps from the palette, is run from the Run dialog, waits for the
 * person on its approval card, and ends with every step marked on the
 * canvas and the run in the history. Then the compiler's side: a flow drawn
 * from a sentence and changed by one, a template taken into the project, a
 * step compiled from its text and tried alone, and a failed step read by the
 * AI, changed, and run again from where it stopped.
 *
 * The flow itself is written through the store once the designer has made
 * it: wiring ports by dragging is the one thing a webdriver does worse than
 * a person, and the engine's own tests cover what the wires do.
 * Run with `npm run test:e2e:fake-claude -- --spec e2e/fake-claude/flows.e2e.cjs`.
 */
const { strict: assert } = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { workspace, fakeClaudeState } = require("../wdio.fake-claude.cjs");

const MODE_FILE = path.join(fakeClaudeState, "mode.txt");
const SHOTS = process.env.AIME_E2E_SHOTS ?? "";

const invoke = (command, args) =>
  browser.executeAsync(
    (name, params, done) => {
      window.__TAURI_INTERNALS__.invoke(name, params).then(done, (error) => done({ error: String(error) }));
    },
    command,
    args,
  );

const flowsState = () =>
  browser.executeAsync((done) => {
    import("/src/stores/flows.ts").then(({ useFlows }) => {
      const state = useFlows.getState();
      done({
        flows: state.flows.map((stored) => ({
          slug: stored.slug,
          steps: stored.flow.steps.map((step) => step.id),
        })),
        view: state.view,
        runs: Object.values(state.runs).map((run) => ({
          id: run.id,
          status: run.status,
          error: run.error,
          waiting: run.waiting === null ? null : run.waiting.step.id,
          steps: Object.fromEntries(Object.entries(run.steps).map(([id, step]) => [id, step.state])),
          outputs: Object.fromEntries(
            Object.entries(run.steps).map(([id, step]) => [
              id,
              step.output === undefined ? null : step.output.value,
            ]),
          ),
        })),
      });
    });
  });

async function shot(name) {
  if (SHOTS === "") return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await browser.saveScreenshot(path.join(SHOTS, `${name}.png`));
}

const FLOW = {
  version: 1,
  name: "Note the files",
  description: "",
  input: { hints: [{ name: "tone", default: "plain", choices: ["plain", "formal"] }] },
  steps: [
    { id: "input", name: "Input", does: "", config: { ability: "input" }, onError: "stop", retries: 0 },
    {
      id: "read",
      name: "Read",
      does: "List the files",
      config: { ability: "ai", permission: "readOnly", json: true },
      onError: "stop",
      retries: 0,
    },
    {
      id: "count",
      name: "Count",
      does: "",
      config: { ability: "transform", program: ".read.value.count" },
      onError: "stop",
      retries: 0,
    },
    {
      id: "gate",
      name: "Many?",
      does: "",
      config: {
        ability: "gate",
        branches: [
          { label: "many", program: ".count.value > 1" },
          { label: "few", program: "true" },
        ],
      },
      onError: "stop",
      retries: 0,
    },
    {
      id: "ask",
      name: "Approve the note",
      does: "Write a note about the files?",
      config: { ability: "human", mode: "approve" },
      onError: "stop",
      retries: 0,
    },
    {
      id: "note",
      name: "Note",
      does: "Write notes/flow.md in a {{input.params.tone}} tone",
      config: { ability: "ai", permission: "edits" },
      onError: "stop",
      retries: 0,
    },
    {
      id: "shrug",
      name: "Nothing to note",
      does: "",
      config: { ability: "wait", seconds: 1 },
      onError: "stop",
      retries: 0,
    },
  ],
  wires: [
    { from: "input", port: "out", to: "read" },
    { from: "read", port: "out", to: "count" },
    { from: "count", port: "out", to: "gate" },
    { from: "gate", port: "many", to: "ask" },
    { from: "gate", port: "few", to: "shrug" },
    { from: "ask", port: "out", to: "note" },
  ],
  settings: { parallel: 3, aiConcurrency: 2, where: "inPlace" },
};

describe("Flows", () => {
  before(async () => {
    await browser.execute((folder) => {
      localStorage.setItem("aime.provider", "claude");
      localStorage.setItem("aime.locale", "en");
      localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: folder, openedAt: Date.now() }]));
    }, workspace);
    await browser.refresh();
    await browser.waitUntil(async () => (await $("body").getText()).includes("RECENT"), { timeout: 30_000 });
    await (await $(`span=${workspace.split(/[\\/]/).pop()}`)).click();
    await browser.waitUntil(async () => (await $("body").getText()).includes("hello.ts"), {
      timeout: 30_000,
    });
    fs.writeFileSync(MODE_FILE, "flow");
  });

  after(() => {
    fs.rmSync(path.join(workspace, ".aime", "flows"), { recursive: true, force: true });
    fs.rmSync(path.join(workspace, ".aime", "flow-runs"), { recursive: true, force: true });
    fs.rmSync(path.join(workspace, ".aime", "flow-trust.json"), { force: true });
  });

  /** The flow as the test wants it, through the store the designer saves with, open in the designer. */
  const saveAndOpen = async (slug, flow) => {
    const outcome = await browser.executeAsync(
      (name, draft, done) => {
        import("/src/stores/flows.ts").then(({ useFlows }) => {
          useFlows
            .getState()
            .save(name, draft)
            .then(
              () => {
                useFlows.getState().openDesigner(name);
                done(true);
              },
              (error) => done(`save failed: ${String(error)}`),
            );
        });
      },
      slug,
      flow,
    );
    assert.equal(outcome, true, String(outcome));
  };

  const storedFlow = (slug) =>
    JSON.parse(fs.readFileSync(path.join(workspace, ".aime", "flows", `${slug}.json`), "utf8"));
  /**
   * The flow once the designer has saved the positions it gave every step: the
   * canvas places a drawn flow on first sight, and autosave writes it a moment later.
   */
  const placedFlow = async (slug, stepIds) => {
    let flow = null;
    await browser.waitUntil(
      async () => {
        flow = storedFlow(slug);
        return stepIds.every((id) => flow.layout?.[id] !== undefined);
      },
      { timeout: 10_000, timeoutMsg: `${slug} was not saved with a place for ${stepIds.join(", ")}` },
    );
    return flow;
  };

  it("makes a flow from the sidebar and fills it from the palette", async () => {
    await (await $('button[title="Flows"]')).click();
    const hub = await $("[data-flows-hub]");
    await hub.waitForExist({ timeout: 10_000, timeoutMsg: "the Flows tab did not open the flows page" });
    // A page of its own: the sidebar folds to its rail and gives the page the width.
    await (
      await $("[data-sidebar-rail]")
    ).waitForExist({
      timeout: 5_000,
      timeoutMsg: "the sidebar did not fold to its rail for the flows page",
    });
    await (await hub.$("[data-flows-new]")).click();
    const dialog = await $('[role="dialog"]');
    await dialog.waitForExist({ timeout: 5_000 });
    await browser.keys(["Control", "a"]);
    await browser.keys("Note the files");
    await browser.keys("Enter");

    const designer = await $("[data-flow-designer]");
    await designer.waitForExist({
      timeout: 10_000,
      timeoutMsg: "the designer did not open for the new flow",
    });
    assert.equal(await designer.getAttribute("data-flow-designer"), "note-the-files");
    await (await $('[data-flow-add="ai"]')).click();
    await (await $('[data-flow-add="transform"]')).click();
    await browser.waitUntil(async () => (await $$("[data-flow-step]")).length === 3, {
      timeout: 5_000,
      timeoutMsg: "the palette did not add two steps to the input",
    });
    // Written to disk a moment after the last click.
    await browser.waitUntil(
      async () => (await $("[data-flow-saved]").getAttribute("data-flow-saved")) === "yes",
      {
        timeout: 5_000,
        timeoutMsg: "the flow was not saved",
      },
    );
    const file = path.join(workspace, ".aime", "flows", "note-the-files.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(
      saved.steps.map((step) => step.id),
      ["input", "ai_1", "transform_1"],
    );
    assert.equal(saved.wires.length, 2, "steps from the palette are wired in line");
    await shot("flows-designer");
  });

  it("is built by hand: a guide on every step, drag and drop, undo, and menus on the right click", async () => {
    // Where the previous test left it: input -> ai_1 -> transform_1, in one row.
    const centre = (selector) =>
      browser.execute((css) => {
        const box = document.querySelector(css)?.getBoundingClientRect();
        return box === undefined
          ? null
          : { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
      }, selector);
    // msedgedriver does not fill in the moves between two points, so a drag is walked.
    const drag = async (from, to, steps = 10) => {
      const pointer = browser.action("pointer").move({ x: from.x, y: from.y }).down();
      for (let step = 1; step <= steps; step++) {
        pointer.move({
          x: Math.round(from.x + ((to.x - from.x) * step) / steps),
          y: Math.round(from.y + ((to.y - from.y) * step) / steps),
          duration: 20,
        });
      }
      await pointer.up().perform();
    };
    const stepIds = async () =>
      browser.execute(() =>
        [...document.querySelectorAll("[data-flow-step]")].map((node) => node.getAttribute("data-flow-step")),
      );
    const stepCount = (count, why) =>
      browser.waitUntil(async () => (await stepIds()).length === count, { timeout: 5_000, timeoutMsg: why });
    const savedFlow = async () => {
      await browser.waitUntil(
        async () => (await $("[data-flow-saved]").getAttribute("data-flow-saved")) === "yes",
        {
          timeout: 5_000,
          timeoutMsg: "the edit was not saved",
        },
      );
      return storedFlow("note-the-files");
    };
    const wired = (flow) => flow.wires.map((wire) => `${wire.from}->${wire.to}`).sort();
    const menuItems = async () => {
      const menu = await $('[role="menu"]');
      await menu.waitForExist({ timeout: 5_000, timeoutMsg: "the right click opened no menu" });
      return browser.execute(() =>
        [...document.querySelectorAll('[role="menu"] [role="menuitem"] span')].map(
          (label) => label.textContent,
        ),
      );
    };

    // A picked step opens with its guide: what it does, how to set it up, how it is wired.
    await (await $('[data-flow-step="ai_1"]')).click();
    const guide = await $('[data-flow-guide="ai"]');
    await guide.waitForExist({ timeout: 5_000, timeoutMsg: "picking a step did not show how to use it" });
    assert.ok((await guide.$$("li")).length >= 2, "the guide lists the steps to set the step up");

    // A step dragged out of the palette and let go on a wire goes between the two steps it joins.
    const wire = await centre('.react-flow__edge[data-id="ai_1:out->transform_1"]');
    assert.ok(wire !== null, "the wire from ai_1 to transform_1 is drawn");
    // The palette scrolls, and Wait sits near its end.
    await (await $('[data-flow-add="wait"]')).scrollIntoView({ block: "center" });
    await drag(await centre('[data-flow-add="wait"]'), wire);
    await stepCount(4, "the step let go on the wire was not added");
    let flow = await savedFlow();
    assert.deepEqual(wired(flow), ["ai_1->wait_1", "input->ai_1", "wait_1->transform_1"]);
    // Room is made for it: the step after the wire moves right instead of being covered.
    const CARD_WIDTH = 192;
    assert.ok(
      flow.layout.wait_1.x >= flow.layout.ai_1.x + CARD_WIDTH &&
        flow.layout.transform_1.x >= flow.layout.wait_1.x + CARD_WIDTH,
      `the inserted step overlaps its neighbours: ${JSON.stringify(flow.layout)}`,
    );
    await (
      await $('[data-flow-guide="wait"]')
    ).waitForExist({
      timeout: 5_000,
      timeoutMsg: "the dropped step was not picked, with its guide",
    });

    // Undo takes the drop back whole, redo puts it back.
    await browser.keys(["Control", "z"]);
    await stepCount(3, "Ctrl+Z did not take the drop back");
    assert.deepEqual(wired(await savedFlow()), ["ai_1->transform_1", "input->ai_1"]);
    await browser.keys(["Control", "y"]);
    await stepCount(4, "Ctrl+Y did not put the drop back");

    // Ctrl+D copies the picked step beside it, unwired; the undo button takes it back.
    await (await $('[data-flow-step="wait_1"]')).click();
    await browser.keys(["Control", "d"]);
    await stepCount(5, "Ctrl+D did not duplicate the picked step");
    assert.ok((await stepIds()).includes("wait_2"));
    await (await $("[data-flow-undo]")).click();
    await stepCount(4, "the undo button did not take the copy back");

    // The right click: a step offers what can be done to it, the canvas what can be added to it.
    await (await $('[data-flow-step="wait_1"]')).click({ button: "right" });
    const onStep = await menuItems();
    for (const item of ["Duplicate", "Copy", "Disconnect its wires", "Delete"]) {
      assert.ok(onStep.includes(item), `the step's menu offers "${item}": ${JSON.stringify(onStep)}`);
    }
    await browser.keys("Escape");
    await (await $('[role="menu"]')).waitForExist({ reverse: true, timeout: 5_000 });
    // Low in the middle of the canvas: the steps sit in the rows at its top.
    const box = await browser.execute(() =>
      document.querySelector(".react-flow__pane")?.getBoundingClientRect().toJSON(),
    );
    await browser
      .action("pointer")
      .move({ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height - 150) })
      .down({ button: 2 })
      .up({ button: 2 })
      .perform();
    const onCanvas = await menuItems();
    for (const item of ["Add a step here…", "Pick every step"]) {
      assert.ok(onCanvas.includes(item), `the canvas menu offers "${item}": ${JSON.stringify(onCanvas)}`);
    }
    await browser.keys("Escape");
    await (await $('[role="menu"]')).waitForExist({ reverse: true, timeout: 5_000 });

    // A wire pulled from a port into empty canvas asks which step to put there, already wired.
    const port = await centre('[data-flow-step="transform_1"] .react-flow__handle[data-handleid="out"]');
    await drag(port, { x: port.x + 30, y: port.y + 180 });
    await menuItems();
    // Typing goes straight into the menu's filter: the hand is still on the mouse.
    await browser.waitUntil(
      () => browser.execute(() => document.activeElement?.closest('[role="menu"]') !== null),
      {
        timeout: 2_000,
        timeoutMsg: "the menu for the loose wire did not take the keyboard",
      },
    );
    // Letter by letter: "Command" whole is the name of a key to webdriver.
    await browser.keys([..."command"]);
    await browser.keys("Enter");
    await stepCount(5, "the step picked for the loose wire was not added");
    flow = await savedFlow();
    assert.ok(
      wired(flow).includes("transform_1->command_1"),
      `the new step is wired from the port: ${JSON.stringify(wired(flow))}`,
    );

    // A wire back to an earlier step is a loop: it gets a round limit, which its menu changes.
    await drag(
      await centre('[data-flow-step="command_1"] .react-flow__handle[data-handleid="out"]'),
      await centre('[data-flow-step="ai_1"] .react-flow__handle[data-handleid="in"]'),
    );
    flow = await savedFlow();
    const loop = flow.wires.find((candidate) => candidate.from === "command_1" && candidate.to === "ai_1");
    assert.equal(loop?.maxRounds, 3, `the loop wire got the usual limit: ${JSON.stringify(flow.wires)}`);
    // Halfway along the drawn path: a loop's bend leaves its bounding box's middle empty.
    const onLoop = await browser.execute(() => {
      const path = document.querySelector(
        '.react-flow__edge[data-id="command_1:out->ai_1"] path.react-flow__edge-path',
      );
      if (path === null) return null;
      const point = path.getPointAtLength(path.getTotalLength() / 2);
      const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM());
      return { x: Math.round(screen.x), y: Math.round(screen.y) };
    });
    assert.ok(onLoop !== null, "the loop wire is drawn");
    await browser.action("pointer").move(onLoop).down({ button: 2 }).up({ button: 2 }).perform();
    const onWire = await menuItems();
    const limit = onWire.find((item) => item.startsWith("Round limit"));
    assert.ok(limit !== undefined, `a loop wire's menu sets its round limit: ${JSON.stringify(onWire)}`);
    await (await $(`[role="menuitem"]*=${limit}`)).click();
    const ask = await $('[role="dialog"] input');
    await ask.waitForExist({ timeout: 5_000, timeoutMsg: "the round limit was not asked for" });
    await browser.keys(["Control", "a"]);
    await browser.keys(["5", "Enter"]);
    await browser.waitUntil(
      async () =>
        (await savedFlow()).wires.find(
          (candidate) => candidate.to === "ai_1" && candidate.from === "command_1",
        )?.maxRounds === 5,
      { timeout: 5_000, timeoutMsg: "the loop wire did not take its new round limit" },
    );

    // A click picks a wire, and Del takes it out like a picked step.
    await browser.action("pointer").move(onLoop).down().up().perform();
    await browser.keys("Delete");
    await browser.waitUntil(
      async () =>
        !(await savedFlow()).wires.some(
          (candidate) => candidate.from === "command_1" && candidate.to === "ai_1",
        ),
      { timeout: 5_000, timeoutMsg: "Del did not delete the picked wire" },
    );
    await shot("flows-designer-by-hand");
  });

  it("runs the flow from the dialog, waits for the person, and ends with every step marked", async () => {
    // The flow as the test wants it, through the store the designer saves with.
    const savedOutcome = await browser.executeAsync((flow, done) => {
      import("/src/stores/flows.ts").then(({ useFlows }) => {
        useFlows
          .getState()
          .save("note-the-files", flow)
          .then(
            () => {
              useFlows.getState().openDesigner("note-the-files");
              done(true);
            },
            (error) => done(`save failed: ${String(error)}`),
          );
      });
    }, FLOW);
    assert.equal(savedOutcome, true, String(savedOutcome));
    try {
      await browser.waitUntil(async () => (await $$("[data-flow-step]")).length === FLOW.steps.length, {
        timeout: 10_000,
        timeoutMsg: "the designer did not show the saved flow",
      });
    } catch (error) {
      await shot("flows-after-save");
      const state = await flowsState();
      const shown = await browser.execute(() =>
        [...document.querySelectorAll("[data-flow-step]")].map((n) => n.getAttribute("data-flow-step")),
      );
      throw new Error(
        `${String(error)} - store: ${JSON.stringify(state.flows)} view: ${JSON.stringify(state.view)} shown: ${JSON.stringify(shown)}`,
      );
    }

    await (await $("[data-flow-run]")).click();
    const input = await $("[data-flow-input]");
    await input.waitForExist({ timeout: 5_000, timeoutMsg: "the run dialog did not open" });
    await input.click();
    await browser.keys("note what is here");
    await (await $("[data-flow-start]")).click();

    const run = await $("[data-flow-run]");
    await run.waitForExist({ timeout: 10_000, timeoutMsg: "the run screen did not open" });
    const ask = await $('[data-flow-ask="approve"]');
    await ask.waitForExist({ timeout: 60_000, timeoutMsg: "the approval card never came" });
    const midway = await flowsState();
    assert.equal(midway.runs[0].waiting, "ask");
    assert.equal(midway.runs[0].steps.gate, "done");
    assert.equal(
      midway.runs[0].steps.shrug,
      "skipped",
      `the other branch: ${JSON.stringify(midway.runs[0].steps)}`,
    );
    await shot("flows-waiting");
    await (await $("[data-flow-approve]")).click();

    await browser.waitUntil(
      async () => (await $("[data-flow-run]").getAttribute("data-flow-run-status")) !== "running",
      {
        timeout: 60_000,
        timeoutMsg: "the run never ended",
      },
    );
    const ended = await flowsState();
    assert.equal(ended.runs[0].status, "done", ended.runs[0].error);
    assert.deepEqual(ended.runs[0].steps, {
      input: "done",
      read: "done",
      count: "done",
      gate: "done",
      ask: "done",
      note: "done",
      shrug: "skipped",
    });
    await shot("flows-done");

    const journal = await invoke("flow_journal_read", {
      root: workspace,
      flow: "note-the-files",
      run: ended.runs[0].id,
    });
    assert.equal(journal.at(-1).kind, "run-done");
    assert.ok(
      journal.some((event) => event.kind === "answered"),
      "the answer was not journaled",
    );

    await (await $('button[title="Back to the designer"]')).click();
    await (await $("button=History")).click();
    const row = await $(`[data-flow-history-run="${ended.runs[0].id}"]`);
    await row.waitForExist({ timeout: 10_000, timeoutMsg: "the run is not in the history" });
    assert.ok((await row.getText()).includes("done"));
  });

  it("draws a flow from a sentence on the flows page, and changes it by one", async () => {
    await (await $("[data-flows-back]")).click();
    const hub = await $("[data-flows-hub]");
    await hub.waitForExist({ timeout: 10_000, timeoutMsg: "the flows page did not open" });
    await shot("flows-hub");
    const box = await $("[data-flows-draw-input]");
    await box.setValue("Count the files of the project");
    await browser.waitUntil(async () => (await $("[data-flows-draw]").getAttribute("disabled")) === null, {
      timeout: 5_000,
      timeoutMsg: `the Draw button stays disabled; the box holds "${await box.getValue()}"`,
    });
    await (await $("[data-flows-draw]")).click();
    const designer = await $('[data-flow-designer="count-the-files"]');
    try {
      await designer.waitForExist({
        timeout: 60_000,
        timeoutMsg: "the drawn flow did not open in the designer",
      });
    } catch (error) {
      // What the app said, for the report: the notices and where the store stands.
      const said = await browser.executeAsync((done) => {
        Promise.all([import("/src/stores/notices.ts"), import("/src/stores/flows.ts")]).then(
          ([{ useNotices }, { useFlows }]) => {
            const flows = useFlows.getState();
            done({
              notices: useNotices.getState().notices.map((notice) => `${notice.what}: ${notice.reason}`),
              drawing: flows.drawing,
              view: flows.view,
              flows: flows.flows.map((stored) => stored.slug),
            });
          },
        );
      });
      throw new Error(`${String(error)} - ${JSON.stringify(said)}`);
    }
    await browser.waitUntil(async () => (await $$("[data-flow-step]")).length === 3, {
      timeout: 10_000,
      timeoutMsg: "the drawn flow does not show its three steps",
    });
    const drawn = await placedFlow("count-the-files", ["input", "list", "count"]);
    assert.deepEqual(
      drawn.steps.map((step) => step.id),
      ["input", "list", "count"],
    );
    assert.equal(drawn.steps[1].config.ability, "files");
    assert.equal(drawn.wires.length, 2);
    await shot("flows-drawn");

    await (await $("[data-flow-edit-by-description]")).click();
    const dialog = await $('[role="dialog"]');
    await dialog.waitForExist({ timeout: 5_000, timeoutMsg: "the change-by-description box did not open" });
    await browser.keys("Then tell me the count");
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await $$("[data-flow-step]")).length === 4, {
      timeout: 60_000,
      timeoutMsg: "the AI's change did not add a step to the canvas",
    });
    const changed = await placedFlow("count-the-files", ["input", "list", "count", "tell"]);
    assert.deepEqual(
      changed.steps.map((step) => step.id),
      ["input", "list", "count", "tell"],
    );
    assert.ok(
      changed.wires.some((wire) => wire.from === "count" && wire.to === "tell"),
      "the new step is not wired after the last one",
    );
    // The steps the change kept stay where they were.
    assert.deepEqual(changed.layout.count, drawn.layout.count);
  });

  it("takes a template into the project", async () => {
    await (await $("[data-flows-back]")).click();
    const card = await $('[data-flows-template="review-pr"]');
    await card.waitForExist({ timeout: 10_000, timeoutMsg: "the templates are not on the flows page" });
    await (await card.$("[data-flows-template-use]")).click();
    const designer = await $('[data-flow-designer="review-a-pr-against-the-checklist"]');
    await designer.waitForExist({
      timeout: 10_000,
      timeoutMsg: "the template did not open as a project flow",
    });
    const taken = storedFlow("review-a-pr-against-the-checklist");
    assert.ok(taken.steps.length > 3, "the template's steps did not come along");
  });

  it("compiles a step from its text, and tries it on what the last run gave it", async () => {
    const flow = structuredClone(FLOW);
    const count = flow.steps.find((step) => step.id === "count");
    count.does = "The number of files that were read";
    count.config.program = ".";
    await saveAndOpen("note-the-files", flow);
    const node = await $('[data-flow-step="count"]');
    await node.waitForExist({ timeout: 10_000, timeoutMsg: "the designer did not show the saved flow" });
    await node.$("[data-flow-compile-needed]").waitForExist({
      timeout: 5_000,
      timeoutMsg: "a step whose text is newer than its config does not say so on the canvas",
    });
    await node.click();
    await $('[data-flow-inspector="count"]').waitForExist({
      timeout: 5_000,
      timeoutMsg: "clicking the step did not open its inspector",
    });
    await (await $("[data-flow-compile]")).click();
    await browser.waitUntil(
      () => {
        const stored = storedFlow("note-the-files").steps.find((step) => step.id === "count");
        return stored.compiled !== undefined && stored.config.program === ".read.value.count";
      },
      { timeout: 60_000, timeoutMsg: "the compiled config did not reach the flow file" },
    );
    await browser.waitUntil(async () => !(await node.$("[data-flow-compile-needed]").isExisting()), {
      timeout: 5_000,
      timeoutMsg: "the canvas still says the step needs compiling",
    });
    await shot("flows-compiled");

    await (await $("[data-flow-try]")).click();
    await browser.waitUntil(
      async () => {
        const state = await flowsState();
        const tried = state.runs.find((run) => run.id === "try-note-the-files");
        return tried !== undefined && tried.steps.count === "done";
      },
      { timeout: 30_000, timeoutMsg: "the step was not tried" },
    );
    const tried = (await flowsState()).runs.find((run) => run.id === "try-note-the-files");
    assert.equal(tried.outputs.count, 2, "the try did not use what the last run's Read step produced");
    const output = await $("[data-flow-inspector] pre");
    assert.ok((await output.getText()).includes("2"), "the Output tab does not show the tried value");
  });

  it("reads a failed step with the AI, applies its change, and runs again from there", async () => {
    const failing = {
      ...structuredClone(FLOW),
      name: "Fails once",
      input: { hints: [] },
      steps: [
        FLOW.steps[0],
        {
          id: "cmd",
          name: "A command",
          does: "",
          config: {
            ability: "command",
            command: { all: [{ program: "node", args: ["-e", "process.exit(1)"] }] },
          },
          onError: "stop",
          retries: 0,
        },
      ],
      wires: [{ from: "input", port: "out", to: "cmd" }],
    };
    await saveAndOpen("fails-once", failing);
    const started = await browser.executeAsync((done) => {
      import("/src/stores/flows.ts").then(({ useFlows }) => {
        useFlows
          .getState()
          .start("fails-once", { text: "", items: [], params: {} })
          .then(
            (id) => {
              useFlows.getState().openRun(id);
              done(id);
            },
            (error) => done({ error: String(error) }),
          );
      });
    });
    assert.equal(typeof started, "string", JSON.stringify(started));
    await browser.waitUntil(
      async () => (await $("[data-flow-run]").getAttribute("data-flow-run-status")) === "failed",
      { timeout: 30_000, timeoutMsg: "the run with an exiting command did not fail" },
    );
    const card = await $('[data-flow-failure="cmd"]');
    await card.waitForExist({ timeout: 5_000, timeoutMsg: "the failed step has no card" });
    await (await $("[data-flow-read-failure]")).click();
    const reading = await $("[data-flow-reading]");
    await reading.waitForExist({ timeout: 60_000, timeoutMsg: "the AI's reading never came" });
    assert.ok((await reading.getText()).includes("exits with 1"));
    await shot("flows-failure-read");
    await (await $("[data-flow-apply-reading]")).click();
    await browser.waitUntil(
      () => {
        const stored = storedFlow("fails-once").steps.find((step) => step.id === "cmd");
        return stored.config.command.all[0].args.includes("console.log('fixed')");
      },
      { timeout: 10_000, timeoutMsg: "the change was not applied to the flow file" },
    );
    await (await $("[data-flow-rerun]")).click();
    await browser.waitUntil(
      async () => {
        const state = await flowsState();
        const runs = state.runs.filter((run) => run.id !== started && !run.id.startsWith("try-"));
        return runs.some((run) => run.status === "done" && run.steps.cmd === "done");
      },
      { timeout: 30_000, timeoutMsg: "the run again from the fixed step did not end well" },
    );
    const again = (await flowsState()).runs.find(
      (run) => run.id !== started && !run.id.startsWith("try-") && run.steps.cmd === "done",
    );
    assert.equal(again.steps.input, "done", "the step before the failed one was not replayed");
    await shot("flows-rerun");
  });
});
