/**
 * The chat specs that need Claude Code's own event stream, run against a
 * stand-in `claude` (`fixtures/fake-claude`) put first on PATH.
 *
 * A configuration of its own rather than part of the main suite: PATH is the
 * app's whole environment, and a run that means to talk to the real CLI - the
 * real-AI verification runs build on `wdio.conf.cjs` - must never find this one
 * first. Run with `npm run test:e2e:fake-claude`.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The app inherits its environment from the launcher, which starts the driver;
// the spec runs in a worker that inherits the launcher's. Set once, here, so
// both name the same folder.
process.env.AIME_FAKE_CLAUDE_STATE ??= fs.mkdtempSync(path.join(os.tmpdir(), "aime-fake-claude-"));
const fakeDir = path.join(__dirname, "fixtures", "fake-claude");
if (!(process.env.PATH ?? "").startsWith(fakeDir)) {
  process.env.PATH = `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`;
}

const base = require("./wdio.conf.cjs");

exports.config = {
  ...base.config,
  specs: [path.join(__dirname, "fake-claude", "*.e2e.cjs")],
  onComplete: async () => {
    fs.rmSync(process.env.AIME_FAKE_CLAUDE_STATE ?? "", { recursive: true, force: true });
    await base.config.onComplete();
  },
};
exports.workspace = base.workspace;
exports.fakeClaudeState = process.env.AIME_FAKE_CLAUDE_STATE;
