import { describe, expect, it } from "vitest";
import { asTaskDef, buildDiscoverTasksPrompt, parseDiscoveredTasks } from "./aiTasks";

/**
 * The parser is the gate between a model's prose and a command Aime will put
 * in front of the user, so every case here is a way a reply can be wrong
 * without looking wrong.
 */
describe("reading the AI's answer about how a project is built", () => {
  it("keeps a complete entry and normalizes the root folder", () => {
    const tasks = parseDiscoveredTasks(
      '{"tasks":[{"kind":"build","label":"mvn package","command":"mvn -q package","dir":".","source":"pom.xml"}]}',
    );

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: "build", command: "mvn -q package", dir: ".", source: "pom.xml" });
    // The root carries no cwd, so the task looks exactly like a detected one.
    expect(asTaskDef(tasks[0])).toEqual({
      id: "ai.build.root",
      label: "mvn package",
      kind: "build",
      command: "mvn -q package",
    });
  });

  it("drops an entry with no source, because an uncited command is a guess", () => {
    const tasks = parseDiscoveredTasks(
      '{"tasks":[{"kind":"build","command":"mvn package"},' +
        '{"kind":"test","command":"mvn test","source":"pom.xml"}]}',
    );

    expect(tasks.map((task) => task.kind)).toEqual(["test"]);
  });

  it("drops an outcome Aime has no menu group for", () => {
    const tasks = parseDiscoveredTasks(
      '{"tasks":[{"kind":"deploy","command":"kubectl apply -f k8s","source":"README.md"}]}',
    );

    expect(tasks).toEqual([]);
  });

  it("reads the JSON out of a reply that wrapped it in prose or a fence", () => {
    const tasks = parseDiscoveredTasks(
      'Here is what I found:\n```json\n{"tasks":[{"kind":"run","label":"gradle bootRun",' +
        '"command":"./gradlew bootRun","dir":"server","source":"build.gradle"}]}\n```\nHope that helps.',
    );

    expect(tasks).toHaveLength(1);
    expect(asTaskDef(tasks[0])).toMatchObject({ id: "ai.run.server", cwd: "server" });
  });

  it("answers with an empty list for prose, rather than throwing at the caller", () => {
    expect(parseDiscoveredTasks("I could not determine how this project builds.")).toEqual([]);
    expect(parseDiscoveredTasks("")).toEqual([]);
    expect(parseDiscoveredTasks('{"tasks":"soon"}')).toEqual([]);
  });

  /**
   * Captured, not composed: this is the reply `claude -p --model haiku` gave
   * on 2026-09-03 when pointed at a Maven repository Aime hard-codes nothing
   * for - a `pom.xml` under `server/`, a `Makefile`, and a README stating the
   * commands. Writing this fixture from memory of "what a model probably
   * returns" is how a parser passes its tests and fails on the real thing.
   */
  it("reads the reply a real model actually sent for a Maven project", () => {
    const captured = [
      "```json",
      "{",
      '  "tasks": [',
      "    {",
      '      "kind": "run",',
      '      "label": "spring-boot:run",',
      '      "command": "mvn spring-boot:run",',
      '      "dir": "server",',
      '      "source": "README.md"',
      "    },",
      "    {",
      '      "kind": "build",',
      '      "label": "mvn package",',
      '      "command": "mvn -q -DskipTests package",',
      '      "dir": "server",',
      '      "source": "README.md"',
      "    },",
      "    {",
      '      "kind": "check",',
      '      "label": "checkstyle",',
      '      "command": "make lint",',
      '      "dir": ".",',
      '      "source": "Makefile"',
      "    }",
      "  ]",
      "}",
      "```",
    ].join("\n");

    const tasks = parseDiscoveredTasks(captured);

    expect(tasks.map((task) => [task.kind, task.command, task.dir])).toEqual([
      ["run", "mvn spring-boot:run", "server"],
      ["build", "mvn -q -DskipTests package", "server"],
      ["check", "make lint", "."],
    ]);
    expect(tasks.map(asTaskDef).map((task) => task.id)).toEqual([
      "ai.run.server",
      "ai.build.server",
      "ai.check.root",
    ]);
    // The model was asked for five outcomes and cited three: a `test` command
    // the README does not state is exactly what must NOT appear.
    expect(tasks.some((task) => task.kind === "test")).toBe(false);
  });

  it("names the outcomes Aime came up empty on, and asks for a citation", () => {
    const prompt = buildDiscoverTasksPrompt(["build", "run"]);

    expect(prompt).toContain("build, run");
    expect(prompt).toContain("`source` names the file you read it from");
    expect(prompt).toContain("Never write a command because it is how projects of this kind usually work");
  });
});
