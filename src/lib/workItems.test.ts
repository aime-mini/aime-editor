import { describe, expect, it } from "vitest";
import {
  autoGroupBy,
  branchNameFor,
  firstOfAll,
  itemOnBranch,
  groupByCategory,
  groupChoices,
  foldedByDefault,
  groupForWorkspace,
  groupItems,
  leadWith,
  matchesQuery,
  namesInRemote,
  relatesToWorkspace,
  typesVary,
  whenText,
} from "./workItems";
import type { WorkItem } from "../stores/trackers";

function item(overrides: Partial<WorkItem>): WorkItem {
  return {
    id: "1",
    title: "Title",
    itemType: "Task",
    state: "Doing",
    category: "inProgress",
    webUrl: "https://dev.azure.com/contoso/Web/_workitems/edit/1",
    displayId: null,
    parent: null,
    dimensions: [],
    ...overrides,
  };
}

describe("branchNameFor", () => {
  it("names a fix after the bug and everything else after the feature", () => {
    expect(branchNameFor(item({ id: "42", itemType: "Bug", title: "Login fails" }))).toBe(
      "bugfix/42-login-fails",
    );
    expect(branchNameFor(item({ id: "42", itemType: "User Story", title: "Login fails" }))).toBe(
      "feature/42-login-fails",
    );
    // The type comes from the service, so its spelling is not Aime's to rely on.
    expect(branchNameFor(item({ id: "7", itemType: "  defect ", title: "Crash" }))).toBe("bugfix/7-crash");
  });

  it("folds accents instead of dropping the words with them", () => {
    // A Vietnamese title has to survive as words, not as leftover consonants.
    expect(branchNameFor(item({ id: "9", title: "Sửa lỗi đăng nhập" }))).toBe("feature/9-sua-loi-dang-nhap");
  });

  it("uses the id a person reads, with the case they read it in", () => {
    // ClickUp addresses a task by an internal id while the team says DEV-123.
    expect(branchNameFor(item({ id: "86a1b2c3", displayId: "DEV-123", title: "Ship login" }))).toBe(
      "feature/DEV-123-ship-login",
    );
    // A Jira key is recognised as `PROJ-12`, so it must not be folded down.
    expect(branchNameFor(item({ id: "PROJ-12", title: "Add login" }))).toBe("feature/PROJ-12-add-login");
    // Anything git would refuse in a name still goes.
    expect(branchNameFor(item({ id: "a b/c", title: "" }))).toBe("feature/a-b-c");
  });

  it("keeps a branch name usable whatever the title contains", () => {
    expect(branchNameFor(item({ id: "3", title: "Fix: the API (v2) — 100% broken!" }))).toBe(
      "feature/3-fix-the-api-v2-100-broken",
    );
    // Nothing but punctuation leaves the id, which is still a valid name.
    expect(branchNameFor(item({ id: "5", title: "???" }))).toBe("feature/5");
    expect(branchNameFor(item({ id: "6", title: "" }))).toBe("feature/6");
    const long = branchNameFor(item({ id: "8", title: "a".repeat(120) }));
    expect(long.length).toBeLessThanOrEqual("feature/8-".length + 40);
    expect(long.endsWith("-")).toBe(false);
  });
});

describe("groupByCategory", () => {
  it("reads in flow order and leaves empty groups out", () => {
    const groups = groupByCategory([
      item({ id: "1", category: "done" }),
      item({ id: "2", category: "todo" }),
      item({ id: "3", category: "inProgress" }),
      item({ id: "4", category: "todo" }),
    ]);
    expect(groups.map((group) => group.category)).toEqual(["inProgress", "todo", "done"]);
    // Inside a group the query's order survives.
    expect(groups[1]?.items.map((entry) => entry.id)).toEqual(["2", "4"]);
  });

  it("shows a state it could not place rather than hiding it", () => {
    const groups = groupByCategory([item({ category: "unknown" })]);
    expect(groups.map((group) => group.category)).toEqual(["unknown"]);
  });

  it("has nothing to say about an empty board", () => {
    expect(groupByCategory([])).toEqual([]);
  });
});

describe("matchesQuery", () => {
  it("finds a Vietnamese title typed without its accents", () => {
    const item_ = item({ title: "Sửa lỗi đăng nhập" });
    expect(matchesQuery(item_, "dang nhap")).toBe(true);
    expect(matchesQuery(item_, "đăng")).toBe(true);
    expect(matchesQuery(item_, "logout")).toBe(false);
  });

  it("matches the id people paste as readily as the title", () => {
    const item_ = item({ id: "iodm/portal#42", displayId: "portal#42", title: "Login fails" });
    expect(matchesQuery(item_, "portal#42")).toBe(true);
    expect(matchesQuery(item_, "42")).toBe(true);
    expect(matchesQuery(item_, "LOGIN")).toBe(true);
  });

  it("keeps everything when nothing was typed", () => {
    expect(matchesQuery(item({}), "")).toBe(true);
    expect(matchesQuery(item({}), "   ")).toBe(true);
  });
});

describe("filing the list", () => {
  const board = (value: string) => [{ label: "Board", value }];

  it("offers every way the service files work, then parent, then status", () => {
    const items = [
      item({ id: "1", dimensions: [...board("Accounts"), { label: "Sprint", value: "S1" }] }),
      item({ id: "2", dimensions: board("Collections"), parent: { id: "9", title: "Login" } }),
    ];
    expect(groupChoices(items)).toEqual([
      { dimension: "Board" },
      { dimension: "Sprint" },
      "parent",
      "status",
    ]);
  });

  it("groups by the first thing the items actually differ along", () => {
    // Two boards on screen is the thing that makes a panel unreadable.
    const twoBoards = [
      item({ id: "1", dimensions: board("Accounts") }),
      item({ id: "2", dimensions: board("Collections") }),
    ];
    expect(autoGroupBy(twoBoards)).toEqual({ dimension: "Board" });

    // One board, mostly children: what they belong to is the useful cut.
    const oneBoard = [
      item({ id: "1", dimensions: board("Accounts"), parent: { id: "9", title: "Login" } }),
      item({ id: "2", dimensions: board("Accounts"), parent: { id: "9", title: "Login" } }),
      item({ id: "3", dimensions: board("Accounts") }),
    ];
    expect(autoGroupBy(oneBoard)).toBe("parent");

    // Independent items on one board: status is what is left to say.
    expect(autoGroupBy([item({ id: "1" }), item({ id: "2" })])).toBe("status");
  });

  it("puts what nothing was said about last, and the urgent work first", () => {
    const groups = groupItems(
      [
        item({ id: "1", category: "todo", parent: { id: "9", title: "Login" } }),
        item({ id: "2", category: "inProgress", parent: { id: "9", title: "Login" } }),
        item({ id: "3", category: "todo" }),
      ],
      "parent",
    );
    expect(groups.map((group) => group.label)).toEqual(["Login", ""]);
    expect(groups[0]?.items.map((entry) => entry.id)).toEqual(["2", "1"]);
  });

  it("keeps the flow order when the heading is a status", () => {
    const groups = groupItems(
      [item({ id: "1", category: "done" }), item({ id: "2", category: "inProgress" })],
      "status",
    );
    expect(groups.map((group) => group.category)).toEqual(["inProgress", "done"]);
  });
});

describe("the board this project is about", () => {
  const board = (value: string) => [{ label: "Board", value }];

  it("reads the names out of a remote, whatever shape the URL is", () => {
    // GitHub labels an issue's repository exactly as `owner/name`, so the pair
    // itself has to be one of the names.
    expect(namesInRemote("git@github.com:iodm/portal.git")).toEqual(["iodm", "portal", "iodm/portal"]);
    // Azure DevOps puts a route word and an encoded project name in the path.
    expect(namesInRemote("https://iodm.visualstudio.com/IODM%20Accounts/_git/Accounts.Api")).toEqual([
      "IODM Accounts",
      "Accounts.Api",
      "IODM Accounts/Accounts.Api",
    ]);
  });

  it("recognises an item by a branch named after it, and not by a longer number", () => {
    const hints = { names: [], branches: ["main", "bugfix/42-login-fails"], current: null };
    expect(relatesToWorkspace(item({ id: "42" }), hints)).toBe(true);
    // `bugfix/42-...` must not claim item 4 or item 420: a branch names one item.
    expect(relatesToWorkspace(item({ id: "4" }), hints)).toBe(false);
    expect(relatesToWorkspace(item({ id: "420" }), hints)).toBe(false);

    // A Jira key survives the dash in its own name.
    expect(
      relatesToWorkspace(item({ id: "10001", displayId: "DEV-123" }), {
        names: [],
        branches: ["feature/DEV-123-export"],
        current: null,
      }),
    ).toBe(true);
  });

  it("recognises the board by the name this repository answers to", () => {
    const hints = { names: ["Accounts.Api", "iodm/portal"], branches: ["main"], current: null };
    // The repository is `Accounts.Api`; the board it belongs to is `Accounts`.
    expect(relatesToWorkspace(item({ dimensions: board("Accounts") }), hints)).toBe(true);
    expect(relatesToWorkspace(item({ dimensions: board("Collections") }), hints)).toBe(false);
    // Three letters in common is a coincidence, not a name.
    expect(relatesToWorkspace(item({ dimensions: board("Acc") }), hints)).toBe(false);
  });

  it("opens one heading, and none at all when two have an equal claim", () => {
    const groups = groupItems(
      [item({ id: "1", dimensions: board("Accounts") }), item({ id: "2", dimensions: board("Collections") })],
      { dimension: "Board" },
    );
    expect(groupForWorkspace(groups, { names: ["Accounts"], branches: [], current: null })).toBe("Accounts");
    // Nothing recognised: every heading stays open rather than one being picked.
    expect(groupForWorkspace(groups, { names: ["Unrelated"], branches: [], current: null })).toBe(null);
    // Both boards named by a branch each - a tie is not an answer.
    const bothNamed = ["feature/1-a", "feature/2-b"];
    expect(groupForWorkspace(groups, { names: [], branches: bothNamed, current: null })).toBe(null);
    // Unless one of them is the branch this repository is standing on: that is
    // what is being worked on here, and it breaks the tie.
    expect(groupForWorkspace(groups, { names: [], branches: bothNamed, current: "feature/2-b" })).toBe(
      "Collections",
    );
  });

  it("leads with that heading, and folds the rest only when folding pays", () => {
    const many = (value: string, count: number): WorkItem[] =>
      Array.from({ length: count }, (_unused, index) =>
        item({ id: `${value}-${String(index)}`, dimensions: [{ label: "Board", value }] }),
      );
    const groups = groupItems([...many("Accounts", 9), ...many("Collections", 2)], { dimension: "Board" });

    expect(leadWith(groups, "Collections").map((group) => group.key)).toEqual(["Collections", "Accounts"]);
    // Nine items behind another heading is more than a screenful: fold it away.
    expect(foldedByDefault(groups, "Collections", 8)).toEqual(["Accounts"]);
    // The other way round, two items are not worth a click to get back.
    expect(foldedByDefault(groups, "Accounts", 8)).toEqual([]);
    // Nothing recognised, nothing hidden and nothing moved.
    expect(foldedByDefault(groups, null, 8)).toEqual([]);
    expect(leadWith(groups, null)).toBe(groups);
  });

  it("files the list along the dimension that names this project", () => {
    const items = [
      item({ id: "1", dimensions: [{ label: "Sprint", value: "S1" }, ...board("Accounts")] }),
      item({ id: "2", dimensions: [{ label: "Sprint", value: "S2" }, ...board("Collections")] }),
    ];
    // Sprint is offered first by the service, but Board is where this project is
    // one heading.
    expect(autoGroupBy(items, { names: ["Collections"], branches: [], current: null })).toEqual({
      dimension: "Board",
    });
    // Without a name to go on, the first dimension that splits the list wins.
    expect(autoGroupBy(items)).toEqual({ dimension: "Sprint" });
  });
});

describe("itemOnBranch", () => {
  const items = [
    item({ id: "42", title: "Login" }),
    item({ id: "7", title: "Shortcut" }),
    item({ id: "DEV-123", displayId: "DEV-123", title: "Export" }),
  ];

  it("finds the item the checked-out branch was started for", () => {
    expect(itemOnBranch(items, "bugfix/42-login")?.id).toBe("42");
    expect(itemOnBranch(items, "feature/DEV-123-export")?.id).toBe("DEV-123");
  });

  it("answers nothing rather than guessing", () => {
    expect(itemOnBranch(items, "main")).toBeNull();
    expect(itemOnBranch(items, null)).toBeNull();
    // 420 is not 42, which a substring search would get wrong.
    expect(itemOnBranch(items, "bugfix/420-other")).toBeNull();
  });
});

describe("firstOfAll", () => {
  const [one, two, three] = [item({ id: "1" }), item({ id: "2" }), item({ id: "3" })];

  it("puts the item being worked on at the top, keeping the rest in order", () => {
    expect(firstOfAll([one, two, three], three).map((each) => each.id)).toEqual(["3", "1", "2"]);
  });

  it("leaves a list it has nothing to say about exactly as it was", () => {
    const items = [one, two];
    expect(firstOfAll(items, null)).toBe(items);
    // An item filtered out of this heading must not be smuggled back into it.
    expect(firstOfAll(items, three)).toBe(items);
  });
});

describe("typesVary", () => {
  it("is false when the word would be the same on every row", () => {
    // What GitHub and ClickUp answer: one type for everything they hold.
    expect(typesVary([item({ itemType: "Issue" }), item({ itemType: "Issue" })])).toBe(false);
    expect(typesVary([item({ itemType: "Bug" }), item({ itemType: "Task" })])).toBe(true);
  });
});

describe("whenText", () => {
  it("reads a stamp the way a person does, whichever service wrote it", () => {
    // ISO 8601 (Azure DevOps, Jira, GitHub) and epoch milliseconds (ClickUp) are
    // the same moment, so they have to read the same.
    const iso = whenText("2026-08-17T09:00:00Z", "en-GB");
    expect(iso).toBe(whenText(String(Date.parse("2026-08-17T09:00:00Z")), "en-GB"));
    expect(iso).toMatch(/2026/);
    expect(iso).not.toMatch(/T09/);
  });

  it("shows what the service said when that is not a date at all", () => {
    expect(whenText("last Tuesday", "en-GB")).toBe("last Tuesday");
    expect(whenText("", "en-GB")).toBe("");
  });
});
