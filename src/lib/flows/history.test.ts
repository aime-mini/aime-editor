import { describe, expect, it } from "vitest";
import { EMPTY_HISTORY, MERGE_WITHIN_MS, recorded, redone, undone } from "./history";
import { emptyFlow } from "./model";

const named = (name: string) => emptyFlow(name);

describe("history", () => {
  it("undoes and redoes edit by edit", () => {
    let history = recorded(EMPTY_HISTORY, named("one"), 10_000);
    history = recorded(history, named("two"), 20_000);
    const back = undone(history, named("three"));
    expect(back?.flow.name).toBe("two");
    const backAgain = back && undone(back.history, back.flow);
    expect(backAgain?.flow.name).toBe("one");
    const forward = backAgain && redone(backAgain.history, backAgain.flow);
    expect(forward?.flow.name).toBe("two");
  });

  it("takes edits made close together back in one step", () => {
    let history = recorded(EMPTY_HISTORY, named("before typing"), 10_000);
    history = recorded(history, named("t"), 10_000 + MERGE_WITHIN_MS / 2);
    history = recorded(history, named("ty"), 10_000 + MERGE_WITHIN_MS);
    expect(history.past.map((flow) => flow.name)).toEqual(["before typing"]);
  });

  it("forgets what was undone once a new edit is made, and has nothing to undo at first", () => {
    expect(undone(EMPTY_HISTORY, named("now"))).toBeNull();
    const history = recorded(EMPTY_HISTORY, named("one"), 10_000);
    const back = undone(history, named("two"));
    if (back === null) throw new Error("nothing undone");
    const edited = recorded(back.history, back.flow, 30_000);
    expect(edited.future).toEqual([]);
    expect(redone(edited, named("x"))).toBeNull();
  });
});
