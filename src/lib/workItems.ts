import type { StateCategory, WorkItem } from "../stores/trackers";

/**
 * The parts of a work item that are the same everywhere, and therefore live
 * here rather than in one service's connector: what order the board reads in,
 * and what a branch for an item is called.
 */

/**
 * Reading order of the groups: what is being worked on, then what is next, then
 * what is over. `unknown` sits before the finished ones — a state Aime could not
 * place is more likely to be live work than done work, and hiding it would be
 * worse than showing it in the wrong place.
 */
export const CATEGORY_ORDER: StateCategory[] = ["inProgress", "todo", "unknown", "done", "removed"];

/** The items of each category, in the order the query returned them. */
export function groupByCategory(items: WorkItem[]): { category: StateCategory; items: WorkItem[] }[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    items: items.filter((item) => item.category === category),
  })).filter((group) => group.items.length > 0);
}

/**
 * How the list is filed on screen: by status, by the item things sit under, or by
 * any way the service itself files work (a label out of `item.dimensions`, so a
 * board, a sprint, a release or a milestone all arrive without the UI knowing
 * what they are).
 */
export type GroupBy = "status" | "parent" | { dimension: string };

/** One heading and what is under it. */
export interface Group {
  /** Stable across renders; what a folded-groups list remembers. */
  key: string;
  label: string;
  /** Set when the heading is a status, so the UI can name it in the reader's own
   * language rather than the service's. */
  category?: StateCategory;
  items: WorkItem[];
}

/** Every way this particular list can be filed, in the order to offer them. */
export function groupChoices(items: WorkItem[]): GroupBy[] {
  const labels: string[] = [];
  for (const item of items) {
    for (const dimension of item.dimensions) {
      if (!labels.includes(dimension.label)) labels.push(dimension.label);
    }
  }
  const choices: GroupBy[] = labels.map((dimension) => ({ dimension }));
  if (items.some((item) => item.parent !== null)) choices.push("parent");
  choices.push("status");
  return choices;
}

/**
 * What the open project is known by, taken from things git can answer without
 * asking any service - which is what keeps this honest: the panel never guesses
 * that a board "looks like" this repository, it recognises names that are
 * literally in it.
 */
export interface WorkspaceHints {
  /** Names this project answers to: its folder, and the names in its remotes. */
  names: string[];
  /** Local branch names, which is where an item id ends up (see `branchNameFor`). */
  branches: string[];
  /**
   * The branch that is checked out, when there is one. It outweighs the others:
   * a repository may carry a branch for every item somebody ever started, but it
   * is standing on exactly one of them.
   */
  current: string | null;
}

/** A project nothing is known about yet; every answer below then says "no idea". */
export const NO_HINTS: WorkspaceHints = { names: [], branches: [], current: null };

/**
 * The names a remote URL carries: the repository, and whatever it sits in.
 *
 * Every service puts them in the last two path segments -
 * `github.com/iodm/portal.git`, `dev.azure.com/iodm/IODM Accounts/_git/Api`,
 * `bitbucket.org/team/repo` - so both are taken, plus the `owner/name` pair
 * itself, because that is exactly how GitHub labels an issue's repository.
 */
export function namesInRemote(url: string): string[] {
  const withoutScheme = url.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@]+@/, "");
  const path = withoutScheme.replace(/:/g, "/").replace(/\.git$/i, "");
  const segments = path
    .split("/")
    .slice(1) // the host says nothing about this repository
    .map((segment) => decodeURIComponent(segment).trim())
    // `_git` (Azure DevOps) and `scm` (Bitbucket Server) are route words, not names.
    .filter((segment) => segment !== "" && segment !== "_git" && segment !== "scm");
  const last = segments.slice(-2);
  return last.length === 2 ? [...last, last.join("/")] : last;
}

/**
 * Whether this item is demonstrably about the open project.
 *
 * Two kinds of evidence, both of them facts rather than resemblance: a branch in
 * this repository is named after the item - Aime's own branch button writes
 * those - or the service files the item under a name this project answers to
 * (its board, its repository, its space).
 */
export function relatesToWorkspace(item: WorkItem, hints: WorkspaceHints): boolean {
  return (
    hints.branches.some((branch) => branchNames(branch, item)) ||
    item.dimensions.some((dimension) => hints.names.some((name) => sameName(dimension.value, name)))
  );
}

/** Whether this branch is the one named after this item. */
function branchNames(branch: string, item: WorkItem): boolean {
  return idsInBranch(branch).includes(branchSafeId(item).toLowerCase());
}

/**
 * The item the checked-out branch was started for, if the branch says so.
 *
 * This is the one thing the panel knows that the board does not: of everything
 * assigned to this person, this is what they are standing on right now. It
 * earns the item a mark and the top of its heading, because scrolling for the
 * row you are already working on is the most avoidable work a board can ask for.
 */
export function itemOnBranch(items: WorkItem[], branch: string | null): WorkItem | null {
  if (branch === null) return null;
  return items.find((item) => branchNames(branch, item)) ?? null;
}

/** The same items with one of them first; used for the item being worked on. */
export function firstOfAll(items: WorkItem[], first: WorkItem | null): WorkItem[] {
  if (first === null || !items.includes(first)) return items;
  return [first, ...items.filter((item) => item !== first)];
}

/**
 * Whether saying what type each item is tells the reader anything.
 *
 * Two of the five services answer with one type for everything they hold -
 * GitHub calls them all "Issue", ClickUp all "Task" - so the word would be the
 * same on every row, which is a column of noise where a title could be.
 */
export function typesVary(items: WorkItem[]): boolean {
  return new Set(items.map((item) => item.itemType)).size > 1;
}

/**
 * What the branch that is checked out is worth. Enough to outweigh a couple of
 * old branches on another heading, because it is the answer to "what is being
 * worked on here" rather than "what was ever worked on here".
 */
const CURRENT_BRANCH_WEIGHT = 3;

/** How strongly one heading claims to be this project's. */
function claimOf(group: Group, hints: WorkspaceHints): number {
  const named = group.items.filter((item) => relatesToWorkspace(item, hints)).length;
  const standingOnIt =
    hints.current !== null && group.items.some((item) => branchNames(hints.current ?? "", item));
  const isTheProject = hints.names.some((name) => sameName(group.label, name));
  return (
    named +
    (standingOnIt ? CURRENT_BRANCH_WEIGHT : 0) +
    // A heading that carries this project's own name speaks for all of its items.
    (isTheProject ? group.items.length + 1 : 0)
  );
}

/**
 * The one heading this project is about, or null when nothing says so.
 *
 * A tie answers null on purpose: folding away the heading someone actually needs
 * is a worse outcome than leaving every heading open, which is what the panel
 * did before it could tell.
 */
export function groupForWorkspace(groups: Group[], hints: WorkspaceHints): string | null {
  // The heading for work nobody filed ("Not filed") is not a board, so it can
  // never be the board this project is about.
  const scored = groups
    .filter((group) => group.label !== "")
    .map((group) => ({ key: group.key, score: claimOf(group, hints) }));
  const best = scored.reduce((left, right) => (right.score > left.score ? right : left), {
    key: "",
    score: 0,
  });
  if (best.score === 0) return null;
  return scored.filter((group) => group.score === best.score).length === 1 ? best.key : null;
}

/** The heading this project is about, first; the rest in the order they were. */
export function leadWith(groups: Group[], first: string | null): Group[] {
  if (first === null) return groups;
  return [...groups].sort((left, right) => Number(right.key === first) - Number(left.key === first));
}

/**
 * The headings that start folded: everything except the one this project is
 * about - and only when folding earns its keep.
 *
 * "Earns its keep" is measured, not assumed: folding away one item from another
 * board saves a line and costs a click, so the rest has to add up to more than a
 * screenful before it is worth hiding. A panel that hides work it was asked to
 * show is a worse panel than a long one.
 */
export function foldedByDefault(groups: Group[], first: string | null, screenful: number): string[] {
  if (first === null) return [];
  const rest = groups.filter((group) => group.key !== first);
  const hidden = rest.reduce((total, group) => total + group.items.length, 0);
  return hidden > screenful ? rest.map((group) => group.key) : [];
}

/**
 * The filing that says the most about *this* list.
 *
 * A dimension the items actually differ along comes first: a panel showing three
 * boards is unreadable until it is grouped by board. Among those, one whose
 * values name the open project wins - that is the cut where this reader's work
 * becomes a single heading. Failing that, work that mostly belongs to something
 * bigger reads best under what it belongs to. What is left is a flat list of
 * independent items, and then status is the useful cut.
 */
export function autoGroupBy(items: WorkItem[], hints: WorkspaceHints = NO_HINTS): GroupBy {
  const splitting = groupChoices(items).filter(
    (choice): choice is { dimension: string } =>
      typeof choice === "object" && new Set(items.map((item) => valueOf(item, choice.dimension))).size > 1,
  );
  const naming = splitting.find((choice) =>
    items.some((item) => hints.names.some((name) => sameName(valueOf(item, choice.dimension), name))),
  );
  if (naming !== undefined) return naming;
  if (splitting.length > 0) return splitting[0];
  const parented = items.filter((item) => item.parent !== null).length;
  return parented * 2 >= items.length && parented > 0 ? "parent" : "status";
}

/**
 * Two names for the same thing. Compared without case, spacing or punctuation,
 * and a longer name that starts with a shorter one counts - a repository called
 * `Accounts.Api` belongs to the board called `Accounts`. Four characters is the
 * floor for that, because three-letter prefixes match by accident.
 */
function sameName(left: string, right: string): boolean {
  const [a, b] = [normalizeName(left), normalizeName(right)];
  if (a === "" || b === "") return false;
  if (a === b) return true;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  return shorter.length >= 4 && longer.startsWith(shorter);
}

function normalizeName(name: string): string {
  return fold(name).replace(/[^a-z0-9/]+/g, "");
}

/**
 * The ids a branch name could be carrying. `feature/DEV-123-login` offers
 * `feature`, `dev`, `123`, `login` and the pairs between them, so both a plain
 * number and a `PROJ-12` key are recognised - and `feature/1234-x` cannot pass
 * for item 123, which is what a substring search would do.
 */
function idsInBranch(branch: string): string[] {
  const words = branch
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const pairs = words.slice(0, -1).map((word, index) => `${word}-${words[index + 1]}`);
  return [...words, ...pairs];
}

/** The item id as a branch would spell it (see `branchNameFor`). */
function branchSafeId(item: WorkItem): string {
  return readableId(item)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Files the list the way asked for, dropping headings nothing is under. */
export function groupItems(items: WorkItem[], by: GroupBy): Group[] {
  if (by === "status") {
    return groupByCategory(items).map((group) => ({
      key: group.category,
      label: group.category,
      category: group.category,
      items: group.items,
    }));
  }

  const keyOf = (item: WorkItem) =>
    by === "parent" ? (item.parent?.title ?? item.parent?.id ?? "") : valueOf(item, by.dimension);
  const groups: Group[] = [];
  for (const item of items) {
    const label = keyOf(item);
    const existing = groups.find((group) => group.key === label);
    if (existing) existing.items.push(item);
    else groups.push({ key: label, label, items: [item] });
  }

  // Inside a heading the urgent work floats up; the heading with nothing to say
  // (an item under nothing, a sprint nobody set) goes last.
  for (const group of groups) {
    group.items.sort((left, right) => rank(left.category) - rank(right.category));
  }
  return groups.sort((left, right) => {
    if (left.key === "") return 1;
    if (right.key === "") return -1;
    return left.label.localeCompare(right.label);
  });
}

function valueOf(item: WorkItem, dimension: string): string {
  return item.dimensions.find((fact) => fact.label === dimension)?.value ?? "";
}

function rank(category: StateCategory): number {
  return CATEGORY_ORDER.indexOf(category);
}

/** Types whose work is a fix; everything else is treated as a feature. */
const FIX_TYPES = ["bug", "defect", "issue", "incident", "hotfix"];

/** Longest slug taken from a title — a branch name has to fit in a terminal. */
const SLUG_LIMIT = 40;

/**
 * The branch a person would name by hand for this item: `bugfix/1234-login-fails`.
 *
 * The name is a suggestion the UI shows in an editable field, never applied
 * silently: teams have their own conventions, and this one only has to be a good
 * starting point.
 */
export function branchNameFor(item: WorkItem): string {
  const prefix = FIX_TYPES.includes(item.itemType.trim().toLowerCase()) ? "bugfix" : "feature";
  // The id a person says out loud is the one they would put in a branch name:
  // `DEV-123`, not the internal `86a1b2c3` ClickUp addresses it by. It keeps its
  // case, because a Jira key is written `PROJ-12` wherever it is meant to be
  // recognised - only characters git will not take are replaced.
  const id = branchSafeId(item);
  const slug = slugify(item.title);
  return slug === "" ? `${prefix}/${id}` : `${prefix}/${id}-${slug}`;
}

/**
 * Whether one item answers what was typed into the filter box.
 *
 * Accents are folded on both sides, because a Vietnamese title typed without
 * them is the same search a person meant: "dang nhap" has to find
 * "Sửa lỗi đăng nhập". The id is matched too, since that is what people paste.
 */
export function matchesQuery(item: WorkItem, query: string): boolean {
  const needle = fold(query);
  if (needle === "") return true;
  return fold(item.title).includes(needle) || fold(readableId(item)).includes(needle);
}

/** Lower case, accent-free, for comparing what people type with what they meant. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().trim();
}

/**
 * A timestamp as a person reads it.
 *
 * Every service stamps a comment differently - ISO 8601 from Azure DevOps, Jira
 * and GitHub, epoch milliseconds as a string from ClickUp - and none of those is
 * something to put in front of a reader. Anything that does not parse is shown
 * exactly as it arrived: the service's own words beat a guess, and beat
 * "Invalid Date" by a mile.
 */
export function whenText(raw: string, locale: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const at = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  if (Number.isNaN(at)) return raw;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(at));
}

/** The id to show, which is not always the one the service is addressed by. */
export function readableId(item: WorkItem): string {
  return item.displayId ?? item.id;
}

/**
 * A title as a branch segment: ASCII, lower case, dash separated.
 *
 * Accents are folded rather than dropped, because a Vietnamese title would
 * otherwise slug down to almost nothing — "Sửa lỗi đăng nhập" has to become
 * `sua-loi-dang-nhap`, not `s-a-l-i-ng-nh-p`. `đ` is a letter of its own and
 * survives decomposition, so it is mapped by hand.
 */
function slugify(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_LIMIT)
    .replace(/-+$/g, "");
}
