/**
 * Jumping through code with a real language server: F12, Ctrl+F12, Shift+F12.
 *
 * Reported 2026-10-11 - "Go to Definition and Go to References do not seem to
 * work", in C# and every other language. The servers were answering; the
 * editor could not use the answers. Its tabs are named `Uri.parse(path)` and
 * the answers were named `Uri.file(path)`, so no place ever matched an open
 * file; the standalone editor had nobody to ask to open another one; and a peek
 * had no text to show for a file that was not open. Only React, Monaco, the
 * Rust side and a running server together show any of that, so this drives all
 * four - the same walk in three languages, each on a project of its own, each
 * skipped where its server is not installed.
 *
 * Reported again 2026-10-12, from the context menu, on a folder holding two
 * solutions: only the first was opened, and every file of the other was
 * analysed alone. So the C# project is shaped like that folder, and the
 * cross-file jumps are clicked in the context menu, the way they were tried.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Whether the operating system can find a program at all. */
function onPath(command) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Where Aime keeps the servers it downloads itself (`lsp/mod.rs`). */
const DOWNLOADED_SERVERS = path.join(process.env.APPDATA ?? "", "com.iodm.aiminieditor", "language-servers");

/**
 * A throwaway project from `{ relativePath: lines }`, removed by the run's own
 * cleanup. Under its long name: the temp folder is handed out in 8.3 form
 * (`LINHPH~1.STS`), and Roslyn keys the project by the long one - a file opened
 * under the short name lands in its miscellaneous project, which knows no
 * other file at all.
 */
function project(name, files) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `aime-${name}-`)));
  for (const [file, lines] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), lines.join("\n") + "\n");
  }
  return dir;
}

/** A solution beside its project, made by the SDK itself, as a real one would be. */
function solution(dir, name, project) {
  const run = (...args) => execFileSync("dotnet", args, { cwd: dir, stdio: "ignore" });
  run("new", "sln", "--name", name, "--format", "sln");
  run("sln", `${name}.sln`, "add", project);
}

/** A C# project file, the same for every project here. */
const CSPROJ = [
  '<Project Sdk="Microsoft.NET.Sdk">',
  "  <PropertyGroup>",
  "    <OutputType>Exe</OutputType>",
  "    <TargetFramework>net10.0</TargetFramework>",
  "  </PropertyGroup>",
  "</Project>",
];

/**
 * The same three things in every language: an interface (or a class standing
 * in for one), what implements it, and a caller in another file. Positions are
 * 1-based, as the editor counts them; `callee` is the file the walk starts in,
 * so the caller is never open before its references are listed. Files are
 * named relative to the project.
 */
const LANGUAGES = [
  {
    languageId: "typescript",
    available: () => onPath("typescript-language-server"),
    serverTimeout: 90_000,
    build: () => {
      const dir = project("navigation-ts", {
        "greeter.ts": [
          "export interface Greeter {",
          "  greet(name: string): string;",
          "}",
          "",
          "export class English implements Greeter {",
          "  greet(name: string): string {",
          "    return `Hello, ${name}`;",
          "  }",
          "}",
        ],
        "main.ts": [
          'import { English, type Greeter } from "./greeter";',
          "",
          "function shout(text: string): string {",
          "  return text.toUpperCase();",
          "}",
          "",
          "const greeter: Greeter = new English();",
          'console.log(shout(greeter.greet("Ada")));',
          'console.log(shout(greeter.greet("Linus")));',
        ],
        "tsconfig.json": [
          '{ "compilerOptions": { "strict": true, "target": "es2022" }, "include": ["*.ts"] }',
        ],
      });
      // typescript-language-server runs the project's own tsserver and refuses to
      // start without one - and a global TypeScript 7 (the native port) has none.
      // A copy, not a link: the run's cleanup deletes this folder recursively.
      fs.cpSync(
        path.dirname(require.resolve("typescript/package.json")),
        path.join(dir, "node_modules", "typescript"),
        {
          recursive: true,
        },
      );
      return dir;
    },
    caller: "main.ts",
    callee: "greeter.ts",
    references: { at: [2, 4], shows: 'greeter.greet("Ada")' }, // `greet` in the interface
    sameFile: { at: [8, 14], lands: 3 }, // `shout(` -> `function shout`
    definition: { at: [7, 31], lands: 5 }, // `new English()` -> `class English`
    implementation: { at: [7, 18], lands: 5 }, // `Greeter` -> `class English implements Greeter`
  },
  {
    languageId: "python",
    available: () => onPath("pyright-langserver"),
    serverTimeout: 90_000,
    build: () =>
      project("navigation-py", {
        "greeter.py": [
          "class English:",
          "    def greet(self, name: str) -> str:",
          '        return f"Hello, {name}"',
        ],
        "main.py": [
          "from greeter import English",
          "",
          "",
          "def shout(text: str) -> str:",
          "    return text.upper()",
          "",
          "",
          'print(shout(English().greet("Ada")))',
          'print(shout(English().greet("Linus")))',
        ],
      }),
    caller: "main.py",
    callee: "greeter.py",
    references: { at: [2, 10], shows: 'English().greet("Ada")' }, // `greet` where it is defined
    sameFile: { at: [8, 8], lands: 4 }, // `shout(` -> `def shout`
    definition: { at: [8, 14], lands: 1 }, // `English()` -> `class English`
  },
  {
    languageId: "csharp",
    available: () => onPath("dotnet") && fs.existsSync(path.join(DOWNLOADED_SERVERS, "roslyn")),
    // Roslyn loads the project and asks Aime to restore it before it answers.
    serverTimeout: 180_000,
    // Two solutions, as in the folder this was reported from: the one sorted
    // first is not the one the files below belong to.
    build: () => {
      const dir = project("navigation-cs", {
        "control-plane/Plane/Plane.csproj": CSPROJ,
        "control-plane/Plane/Plane.cs": ["namespace Plane;", "", "public class Control { }"],
        "src/Navigation/Navigation.csproj": CSPROJ,
        "src/Navigation/Greeter.cs": [
          "namespace Navigation;",
          "",
          "public interface IGreeter",
          "{",
          "    string Greet(string name);",
          "}",
          "",
          "public class English : IGreeter",
          "{",
          '    public string Greet(string name) => $"Hello, {name}";',
          "}",
        ],
        "src/Navigation/Program.cs": [
          "using Navigation;",
          "",
          "IGreeter greeter = new English();",
          'Console.WriteLine(greeter.Greet("Ada"));',
          'Console.WriteLine(greeter.Greet("Linus"));',
        ],
      });
      solution(path.join(dir, "control-plane"), "Plane", "Plane/Plane.csproj");
      solution(path.join(dir, "src"), "Navigation", "Navigation/Navigation.csproj");
      return dir;
    },
    caller: "src/Navigation/Program.cs",
    callee: "src/Navigation/Greeter.cs",
    references: { at: [5, 13], shows: 'greeter.Greet("Ada")' }, // `Greet` in the interface
    definition: { at: [3, 26], lands: 8 }, // `new English()` -> `public class English`
    implementation: { at: [3, 3], lands: 8 }, // `IGreeter` -> `class English : IGreeter`
  },
];

/** The file in front and the line the cursor is on, asked of the editor itself. */
const whereAmI = () =>
  browser.executeAsync((done) => {
    import("/src/lib/monacoAccess.ts").then(({ activeEditor }) => {
      const editor = activeEditor();
      const model = editor?.getModel();
      const position = editor?.getPosition();
      done(
        model && position ? { file: model.uri.path.split(/[\\/]/).pop(), line: position.lineNumber } : null,
      );
    }, done);
  });

/** Puts the cursor on a line and column of the file in front, and the focus in the editor. */
const placeCursor = ([lineNumber, column]) =>
  browser.executeAsync(
    (line, col, done) => {
      import("/src/lib/monacoAccess.ts").then(({ activeEditor }) => {
        const editor = activeEditor();
        editor?.setPosition({ lineNumber: line, column: col });
        editor?.focus();
        done(true);
      }, done);
    },
    lineNumber,
    column,
  );

/**
 * Opens files of the open project as tabs, all at once - the way a workspace
 * reopens with its tabs. The workspace store is the page's own instance: once
 * Vite has hot-updated it the page loads it as `?t=...`, and a bare import
 * would make a second, empty store.
 */
const openTogether = (files) =>
  browser.executeAsync((targets, done) => {
    const store = "/src/stores/workspace.ts";
    const loaded =
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => name.includes(store))
        .pop() ?? store;
    import(loaded).then(({ useWorkspace }) => {
      Promise.all(targets.map((target) => useWorkspace.getState().openFile(target))).then(done, done);
    }, done);
  }, files);

/** Brings a file of the open project to the front, as a tab. */
async function bringToFront(folder, file) {
  await openTogether([path.join(folder, file)]);
  await browser.waitUntil(async () => (await whereAmI())?.file === path.basename(file), {
    timeout: 15_000,
    timeoutMsg: `${file} never came to the front`,
  });
}

/** Opens a folder from the welcome screen's Recent list. */
async function openFolder(folder) {
  await browser.execute((recent) => {
    localStorage.setItem("aime.recentFolders", JSON.stringify([{ path: recent, openedAt: Date.now() }]));
  }, folder);
  await browser.refresh();
  await browser.waitUntil(async () => (await $("body").getText()).toLowerCase().includes("recent"), {
    timeout: 30_000,
    timeoutMsg: "the welcome screen never rendered",
  });
  await (await $(`span=${path.basename(folder)}`)).click();
}

/** The process ids of every Roslyn server running on this machine. */
function roslynServers() {
  const program = "Microsoft.CodeAnalysis.LanguageServer";
  const [command, args] =
    process.platform === "win32"
      ? [
          "powershell",
          ["-NoProfile", "-Command", `(Get-Process ${program} -ErrorAction SilentlyContinue).Id`],
        ]
      : ["pgrep", ["-f", program]];
  try {
    return execFileSync(command, args, { encoding: "utf8" }).split(/\s+/).filter(Boolean);
  } catch {
    // pgrep exits 1 when nothing matches.
    return [];
  }
}

/** Where on screen a line and column of the file in front is drawn. */
const pointAt = ([lineNumber, column]) =>
  browser.executeAsync(
    (line, col, done) => {
      import("/src/lib/monacoAccess.ts").then(({ activeEditor }) => {
        const editor = activeEditor();
        const spot = editor?.getScrolledVisiblePosition({ lineNumber: line, column: col });
        const box = editor?.getDomNode()?.getBoundingClientRect();
        done(
          spot && box
            ? { x: Math.round(box.left + spot.left + 2), y: Math.round(box.top + spot.top + spot.height / 2) }
            : null,
        );
      }, done);
    },
    lineNumber,
    column,
  );

/** The editor's context menu item labelled `label`, once the menu shows it. */
async function menuItem(label) {
  let found;
  await browser.waitUntil(
    async () => {
      for (const item of await $$(">>>.monaco-menu .action-label")) {
        if ((await item.getText()).trim() === label) found = item;
      }
      return found !== undefined;
    },
    { timeout: 5_000, timeoutMsg: `the context menu never offered "${label}"` },
  );
  return found;
}

/** A right click on a line and column, then a click on one item of the menu it opens. */
function fromContextMenu(label) {
  return async (at) => {
    const point = await pointAt(at);
    if (point === null) throw new Error(`no point on screen for ${JSON.stringify(at)}`);
    await browser
      .action("pointer")
      .move({ x: point.x, y: point.y, origin: "viewport" })
      .down({ button: 2 })
      .up({ button: 2 })
      .perform();
    await (await menuItem(label)).click();
  };
}

/** Keys pressed with the cursor on a line and column. */
function withKeys(keys) {
  return async (at) => {
    await placeCursor(at);
    await browser.keys(keys);
  };
}

/** How long an answer is waited for: a server still reading the project answers "nowhere" rather than late. */
const ANSWER_DEADLINE_MS = 90_000;

/** Asks for a jump from the same place until it lands where `landed` says. */
async function jumpUntil(ask, folder, file, at, landed, message) {
  const deadline = Date.now() + ANSWER_DEADLINE_MS;
  for (;;) {
    await bringToFront(folder, file);
    await placeCursor(at);
    await ask(at);
    try {
      await browser.waitUntil(async () => landed(await whereAmI()), { timeout: 3_000, interval: 150 });
      return;
    } catch {
      // A peek opened by the jump would take the next attempt's keys.
      await browser.keys(["Escape"]);
      if (Date.now() >= deadline) {
        throw new Error(`${message}; the editor is at ${JSON.stringify(await whereAmI())}`);
      }
    }
  }
}

/** The rows of the open peek, whitespace collapsed. */
const peekRows = () =>
  browser.execute(() =>
    [...document.querySelectorAll(".peekview-widget .monaco-list-row")].map((row) =>
      row.textContent.replace(/\s+/g, " ").trim(),
    ),
  );

for (const language of LANGUAGES) {
  describe(`Code navigation in ${language.languageId}`, () => {
    let folder;
    const caller = path.basename(language.caller);
    const callee = path.basename(language.callee);

    before(async function () {
      if (!language.available()) {
        console.log(
          `[code-navigation.e2e] SKIPPED ${language.languageId}: its server is not on this machine.`,
        );
        this.skip();
      }
      folder = language.build();
      await openFolder(folder);
      await bringToFront(folder, language.callee);

      // The status bar's language chip turns green once the server is running;
      // its title says why when it does not.
      const chip = () =>
        browser.execute((id) => {
          const button = [...document.querySelectorAll("button")].find(
            (node) => node.textContent.trim() === id,
          );
          return button ? { running: button.className.includes("text-ok"), title: button.title } : null;
        }, language.languageId);
      try {
        await browser.waitUntil(async () => (await chip())?.running === true, {
          timeout: language.serverTimeout,
        });
      } catch {
        throw new Error(`the ${language.languageId} server never ran: ${JSON.stringify(await chip())}`);
      }
    });

    // First, while the caller has never been opened: every line the peek shows
    // of it comes from a model opened for the peek.
    it("lists the references in a file that is not open, from the context menu", async () => {
      const { at, shows } = language.references;
      const deadline = Date.now() + ANSWER_DEADLINE_MS;
      let rows = [];
      for (;;) {
        await placeCursor(at);
        await fromContextMenu("Go to References")(at);
        try {
          await browser.waitUntil(async () => (rows = await peekRows()).some((row) => row.includes(caller)), {
            timeout: 4_000,
            interval: 200,
          });
          break;
        } catch {
          await browser.keys(["Escape"]);
          if (Date.now() >= deadline) {
            throw new Error(`the peek never listed ${caller}: ${JSON.stringify(rows)}`);
          }
        }
      }
      // A file's group can start folded; a click on it unfolds its lines.
      if (!rows.some((row) => row.includes(shows))) {
        await browser.execute((name) => {
          const group = [...document.querySelectorAll(".peekview-widget .monaco-list-row")].find((row) =>
            row.textContent.includes(name),
          );
          group?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        }, caller);
      }
      try {
        await browser.waitUntil(async () => (rows = await peekRows()).some((row) => row.includes(shows)), {
          timeout: 10_000,
        });
      } catch {
        throw new Error(`a reference in ${caller} shows no text: ${JSON.stringify(rows)}`);
      }
      console.log(`[code-navigation.e2e] ${language.languageId} peek: ${JSON.stringify(rows)}`);
      await browser.keys(["Escape"]);
    });

    if (language.sameFile) {
      it("jumps to a definition in the same file", async () => {
        const { at, lands } = language.sameFile;
        await jumpUntil(
          withKeys(["F12"]),
          folder,
          language.caller,
          at,
          (where) => where?.file === caller && where.line === lands,
          "F12 on a call never reached the function declared above it",
        );
      });
    }

    it("opens the file a definition is in, on its line, from the context menu", async () => {
      const { at, lands } = language.definition;
      await jumpUntil(
        fromContextMenu("Go to Definition"),
        folder,
        language.caller,
        at,
        (where) => where?.file === callee && where.line === lands,
        "Go to Definition on a class from another file never opened that file at the class",
      );
    });

    if (language.implementation) {
      it("goes from an interface to the class that implements it", async () => {
        const { at, lands } = language.implementation;
        await jumpUntil(
          withKeys(["Control", "F12"]),
          folder,
          language.caller,
          at,
          (where) => where?.file === callee && where.line === lands,
          "Ctrl+F12 on an interface never reached its implementation",
        );
      });
    }
  });
}

/** The longest one click is given to land on a server that is still getting ready (`JUMP_WAIT_MS`). */
const EARLY_JUMP_DEADLINE_MS = 240_000;

// Reported 2026-10-12, on a workspace that reopened with two C# tabs: each tab
// started a Roslyn of its own, and a click made while the server was starting
// or loading the solution did nothing at all. Measured on nopCommerce, the
// shop that report came from is built on: the menu had no Go to Definition for
// the first seconds, then every symbol answered "nowhere" for forty more.
describe("A jump asked before the C# server is ready", () => {
  const csharp = LANGUAGES.find((language) => language.languageId === "csharp");

  it("lands from one click, on one server", async function () {
    if (!csharp.available()) this.skip();
    this.timeout(EARLY_JUMP_DEADLINE_MS + 60_000);
    const runningBefore = roslynServers();
    const folder = csharp.build();
    await openFolder(folder);
    await openTogether([path.join(folder, csharp.callee), path.join(folder, csharp.caller)]);
    await bringToFront(folder, csharp.caller);

    const { at, lands } = csharp.definition;
    await placeCursor(at);
    await fromContextMenu("Go to Definition")(at);
    const callee = path.basename(csharp.callee);
    try {
      await browser.waitUntil(
        async () => {
          const where = await whereAmI();
          return where?.file === callee && where.line === lands;
        },
        { timeout: EARLY_JUMP_DEADLINE_MS, interval: 500 },
      );
    } catch {
      throw new Error(`one early click never landed; the editor is at ${JSON.stringify(await whereAmI())}`);
    }
    const started = roslynServers().filter((pid) => !runningBefore.includes(pid));
    if (started.length !== 1) {
      throw new Error(`the workspace started ${String(started.length)} Roslyn servers, not one`);
    }
  });
});
