import { TIERS, tierOfKind, type Tier } from "./cloudIcons";
import type { CloudResource } from "../stores/cloud";

/**
 * Turning a flat list of cloud resources into the applications it is made of.
 *
 * This exists because a list cannot answer the question people actually bring
 * to a cloud console: *which of these ten applications is this, and what is it
 * made of?* Six thousand rows sorted by resource type answer "how many
 * databases are there", which is a different and much smaller question.
 *
 * Two things make the answer honest rather than invented:
 *
 * 1. **The application comes from the team's own tags**, and the basis is
 *    CHOSEN FROM THE DATA rather than from a fixed list of favourite keys. The
 *    first version trusted a short list (`app`, `service`, `project`…) and
 *    required it to cover a quarter of the account; measured against a real
 *    account of 6,252 resources (2026-09-03) that fell through to "group by
 *    account number" - one blob - while the team's actual application tag,
 *    `Area` (71 values over 627 resources), was ignored because nobody had put
 *    `Area` on the list. So every tag key is a candidate, scored by how well it
 *    PARTITIONS: a key with one value for everything (`Env`) says nothing, a
 *    key with a value per resource (`Purpose`, `Name`) is a label rather than a
 *    grouping, and what is left is ranked by how much it covers. The person
 *    can pick any candidate; the map always says which it used.
 *
 * 2. **The arrows are tiers, and the map says so.** A real dependency graph -
 *    this function reads that table - is not in any listing; it lives in each
 *    service's own configuration. What IS a fact is the tier a service belongs
 *    to, because that is a property of what it is: something faces the world,
 *    something runs code, something holds state. Drawing that flow is useful
 *    and true. Drawing measured dependencies would be neither.
 */

/** What the grouping is based on, so the UI can say it out loud. */
export type Basis =
  | { kind: "tag"; key: string }
  /**
   * The CloudFormation stack that created each resource - a fact the cloud
   * itself records on every resource a stack owns (`aws:cloudformation:stack-name`),
   * and the stack resource is filed with its own children.
   */
  | { kind: "stack" }
  /** Azure's resource group, or AWS's account number. */
  | { kind: "group" }
  | { kind: "none" };

/** One way this account could be divided, with how well it does it. */
export interface BasisOption {
  basis: Basis;
  /** Resources the basis says something about. */
  covered: number;
  /** Applications it would produce. */
  apps: number;
}

/** One application, and the resources it is made of, by tier. */
export interface AppGroup {
  name: string;
  /** Every resource in it, so a count and a click-through are both possible. */
  resources: CloudResource[];
  /** The resources of each tier, tiers with nothing in them left out. */
  tiers: [Tier, CloudResource[]][];
}

export interface CloudMap {
  /** The basis actually used. */
  basis: Basis;
  /** Every basis worth offering, best first; the first is the automatic choice. */
  options: BasisOption[];
  apps: AppGroup[];
}

/** One kind of resource inside a tier: what a diagram draws as a single box. */
export interface KindNode {
  kind: string;
  resources: CloudResource[];
}

/** Where resources land when nothing says which application they serve. */
export const UNTAGGED = "—";

/** The tag the cloud itself writes on everything a CloudFormation stack owns. */
const STACK_TAG = "aws:cloudformation:stack-name";

/** The kind of the stack resource itself, which is filed with its children. */
const STACK_KIND = "cloudformation/stack";

/**
 * Fewer values than this and a key is a status, not a grouping: `Env` with
 * `dev`/`prod` divides an account in two, and neither half is an application.
 */
const MIN_APPS = 3;

/**
 * The tag keys that can name an application, ranked.
 *
 * Eligible: at least `MIN_APPS` distinct values, and on average at least two
 * resources per value - a key with a value per resource (`Purpose`, `Name`) is
 * a label, not a grouping. Ranked by how much of what it covers it actually
 * divides: `covered × (1 − values / covered)`, so a key covering 627 resources
 * in 71 groups (556) beats one covering 294 in 44 (250), and both beat a key
 * covering 920 in 799 (121) even before eligibility removes it.
 */
function tagOptions(resources: CloudResource[]): { option: BasisOption; score: number }[] {
  const values = new Map<string, Set<string>>();
  const covered = new Map<string, number>();
  for (const resource of resources) {
    for (const [key, value] of Object.entries(resource.tags)) {
      // The cloud's own bookkeeping tags are not the team's statement of what
      // belongs together; the one that is - the stack - has its own basis.
      if (key.includes(":")) continue;
      covered.set(key, (covered.get(key) ?? 0) + 1);
      const seen = values.get(key) ?? new Set<string>();
      seen.add(value);
      values.set(key, seen);
    }
  }
  return [...covered.entries()]
    .map(([key, count]) => {
      const basis: Basis = { kind: "tag", key };
      const apps = values.get(key)?.size ?? 0;
      return { option: { basis, covered: count, apps }, score: count * (1 - apps / count) };
    })
    .filter(({ option }) => option.apps >= MIN_APPS && option.apps * 2 <= option.covered)
    .sort((left, right) => right.score - left.score || left.option.covered - right.option.covered);
}

/**
 * Every basis worth offering for this account, best first.
 *
 * Tags first, because a tag is the team saying what belongs together; the
 * stack next, because the cloud recorded it; the group last, because it is
 * the coarsest statement there is. A basis that would produce a single
 * application is not offered - it divides nothing.
 */
export function basesOf(resources: CloudResource[]): BasisOption[] {
  const options: BasisOption[] = tagOptions(resources).map(({ option }) => option);

  const stacks = new Set<string>();
  let inStacks = 0;
  for (const resource of resources) {
    const stack = stackOf(resource);
    if (stack !== null) {
      stacks.add(stack);
      inStacks += 1;
    }
  }
  if (stacks.size >= 2) options.push({ basis: { kind: "stack" }, covered: inStacks, apps: stacks.size });

  const groups = new Set(resources.map((resource) => resource.group).filter((group) => group !== ""));
  if (groups.size >= 2) {
    options.push({
      basis: { kind: "group" },
      covered: resources.filter((resource) => resource.group !== "").length,
      apps: groups.size,
    });
  }
  return options;
}

/** The stack a resource belongs to, when the cloud says it belongs to one. */
function stackOf(resource: CloudResource): string | null {
  if (resource.kind === STACK_KIND) return resource.name;
  return resource.tags[STACK_TAG] ?? null;
}

/** The application one resource belongs to, on the chosen basis. */
function appOf(resource: CloudResource, basis: Basis): string {
  switch (basis.kind) {
    case "tag":
      return resource.tags[basis.key] ?? UNTAGGED;
    case "stack":
      return stackOf(resource) ?? UNTAGGED;
    case "group":
      return resource.group === "" ? UNTAGGED : resource.group;
    case "none":
      return UNTAGGED;
  }
}

/** Whether two bases are the same choice. */
export function sameBasis(left: Basis, right: Basis): boolean {
  return left.kind === right.kind && (left.kind !== "tag" || right.kind !== "tag" || left.key === right.key);
}

/**
 * The applications in one account, biggest first, with `—` last.
 *
 * `chosen` is the person's pick from `options`; absent, or no longer among
 * them, the best option is used. Biggest first for the same reason the resource
 * groups are: it is the order that says what this account is mostly for. The
 * untagged bucket goes last however big it is, because it is a gap rather than
 * an application.
 */
export function mapOf(resources: CloudResource[], chosen?: Basis): CloudMap {
  const options = basesOf(resources);
  const picked = chosen === undefined ? undefined : options.find((option) => sameBasis(option.basis, chosen));
  const basis: Basis = picked?.basis ?? options.at(0)?.basis ?? { kind: "none" };

  const byApp = new Map<string, CloudResource[]>();
  for (const resource of resources) {
    const name = appOf(resource, basis);
    const bucket = byApp.get(name);
    if (bucket === undefined) byApp.set(name, [resource]);
    else bucket.push(resource);
  }

  const apps: AppGroup[] = [...byApp.entries()]
    .map(([name, owned]) => ({ name, resources: owned, tiers: tiersOf(owned) }))
    .sort((left, right) => {
      if (left.name === UNTAGGED) return 1;
      if (right.name === UNTAGGED) return -1;
      return right.resources.length - left.resources.length || left.name.localeCompare(right.name);
    });

  return { basis, options, apps };
}

/** One application's resources split into tiers, in request order. */
function tiersOf(resources: CloudResource[]): [Tier, CloudResource[]][] {
  const byTier = new Map<Tier, CloudResource[]>();
  for (const resource of resources) {
    const tier = tierOfKind(resource.kind);
    const bucket = byTier.get(tier);
    if (bucket === undefined) byTier.set(tier, [resource]);
    else bucket.push(resource);
  }
  return TIERS.filter((tier) => byTier.has(tier)).map((tier) => [tier, byTier.get(tier) ?? []]);
}

/**
 * The kinds in a set of resources, most numerous first.
 *
 * This is what a diagram draws: 787 functions are ONE box saying "787", the
 * way an architecture diagram shows a component rather than every instance of
 * it. The instances stay reachable inside the box.
 */
export function nodesOf(resources: CloudResource[]): KindNode[] {
  const byKind = new Map<string, CloudResource[]>();
  for (const resource of resources) {
    const bucket = byKind.get(resource.kind);
    if (bucket === undefined) byKind.set(resource.kind, [resource]);
    else bucket.push(resource);
  }
  return [...byKind.entries()]
    .map(([kind, owned]) => ({ kind, resources: owned }))
    .sort(
      (left, right) => right.resources.length - left.resources.length || left.kind.localeCompare(right.kind),
    );
}
