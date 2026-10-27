import {
  Bot,
  Clock,
  Cloud,
  FileText,
  FlaskConical,
  GitFork,
  GitPullRequest,
  Globe,
  Layers,
  ListTodo,
  LogIn,
  Mail,
  Plug,
  Shuffle,
  Split,
  Terminal,
  UserRound,
  Wand2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { TranslationKey } from "../../i18n/en";
import { DEFAULT_RETRIES, type Ability, type Step, type StepConfig } from "../../lib/flows/model";

/**
 * How each ability looks, and what the palette offers: an entry is an
 * ability with a starting config - "Diff git" is a git step set to diff,
 * "Ticket" a service step on the tracker - so a step dropped in already
 * does the thing its name says.
 */

export interface AbilityLook {
  icon: LucideIcon;
  /** Tailwind classes for the swatch behind the icon. */
  swatch: string;
  label: TranslationKey;
  note: TranslationKey;
  /** The help page for this kind of step, shown from the inspector's "?". */
  help: TranslationKey;
}

export const ABILITIES: Record<Ability, AbilityLook> = {
  input: {
    icon: LogIn,
    swatch: "bg-slate-400 text-slate-950",
    label: "flows.ability.input",
    note: "flows.ability.input.note",
    help: "flows.help.input",
  },
  ai: {
    icon: Bot,
    swatch: "bg-sky-400 text-sky-950",
    label: "flows.ability.ai",
    note: "flows.ability.ai.note",
    help: "flows.help.ai",
  },
  command: {
    icon: Terminal,
    swatch: "bg-violet-400 text-violet-950",
    label: "flows.ability.command",
    note: "flows.ability.command.note",
    help: "flows.help.command",
  },
  transform: {
    icon: Shuffle,
    swatch: "bg-teal-400 text-teal-950",
    label: "flows.ability.transform",
    note: "flows.ability.transform.note",
    help: "flows.help.transform",
  },
  gate: {
    icon: Split,
    swatch: "bg-amber-400 text-amber-950",
    label: "flows.ability.gate",
    note: "flows.ability.gate.note",
    help: "flows.help.gate",
  },
  wait: {
    icon: Clock,
    swatch: "bg-amber-300 text-amber-950",
    label: "flows.ability.wait",
    note: "flows.ability.wait.note",
    help: "flows.help.wait",
  },
  human: {
    icon: UserRound,
    swatch: "bg-pink-400 text-pink-950",
    label: "flows.ability.human",
    note: "flows.ability.human.note",
    help: "flows.help.human",
  },
  http: {
    icon: Globe,
    swatch: "bg-orange-400 text-orange-950",
    label: "flows.ability.http",
    note: "flows.ability.http.note",
    help: "flows.help.http",
  },
  service: {
    icon: Plug,
    swatch: "bg-orange-400 text-orange-950",
    label: "flows.ability.service",
    note: "flows.ability.service.note",
    help: "flows.help.service",
  },
  git: {
    icon: GitFork,
    swatch: "bg-emerald-400 text-emerald-950",
    label: "flows.ability.git",
    note: "flows.ability.git.note",
    help: "flows.help.git",
  },
  mail: {
    icon: Mail,
    swatch: "bg-orange-300 text-orange-950",
    label: "flows.ability.mail",
    note: "flows.ability.mail.note",
    help: "flows.help.mail",
  },
  files: {
    icon: FileText,
    swatch: "bg-teal-300 text-teal-950",
    label: "flows.ability.files",
    note: "flows.ability.files.note",
    help: "flows.help.files",
  },
  subflow: {
    icon: Layers,
    swatch: "bg-slate-400 text-slate-950",
    label: "flows.ability.subflow",
    note: "flows.ability.subflow.note",
    help: "flows.help.subflow",
  },
  free: {
    icon: Wand2,
    swatch: "bg-indigo-400 text-indigo-950",
    label: "flows.ability.free",
    note: "flows.ability.free.note",
    help: "flows.help.free",
  },
};

export function abilityOf(step: Step): AbilityLook {
  return ABILITIES[step.config.ability];
}

/** One thing the palette offers: an ability, started the way the name says. */
export interface PaletteEntry {
  key: string;
  ability: Ability;
  label: TranslationKey;
  note: TranslationKey;
  icon?: LucideIcon;
  config: StepConfig;
  /** What the step says it does, to start from. */
  does?: string;
}

export const PALETTE: { group: TranslationKey; entries: PaletteEntry[] }[] = [
  {
    group: "flows.palette.quick",
    entries: [
      {
        key: "free",
        ability: "free",
        label: "flows.ability.free",
        note: "flows.ability.free.note",
        config: { ability: "free" },
      },
    ],
  },
  {
    group: "flows.palette.ai",
    entries: [
      {
        key: "ai",
        ability: "ai",
        label: "flows.ability.ai",
        note: "flows.ability.ai.note",
        config: { ability: "ai", permission: "readOnly" },
      },
    ],
  },
  {
    group: "flows.palette.data",
    entries: [
      {
        key: "files",
        ability: "files",
        label: "flows.ability.files",
        note: "flows.ability.files.note",
        config: { ability: "files", globs: ["README.md"] },
      },
      {
        key: "diff",
        ability: "git",
        label: "flows.palette.diff",
        note: "flows.palette.diff.note",
        icon: GitFork,
        config: { ability: "git", action: "diff" },
      },
      {
        key: "ticket",
        ability: "service",
        label: "flows.palette.ticket",
        note: "flows.palette.ticket.note",
        icon: ListTodo,
        config: { ability: "service", door: "tracker", action: "detail" },
      },
      {
        key: "transform",
        ability: "transform",
        label: "flows.ability.transform",
        note: "flows.ability.transform.note",
        config: { ability: "transform", program: "." },
      },
    ],
  },
  {
    group: "flows.palette.outside",
    entries: [
      {
        key: "http",
        ability: "http",
        label: "flows.ability.http",
        note: "flows.ability.http.note",
        config: { ability: "http", method: "GET", url: "https://", parse: "json" },
      },
      {
        key: "mcp",
        ability: "service",
        label: "flows.palette.mcp",
        note: "flows.palette.mcp.note",
        icon: Plug,
        config: { ability: "service", door: "mcp", server: "" },
      },
      {
        key: "mail",
        ability: "mail",
        label: "flows.ability.mail",
        note: "flows.ability.mail.note",
        config: { ability: "mail", connection: "", to: [], subject: "", body: "" },
      },
    ],
  },
  {
    group: "flows.palette.run",
    entries: [
      {
        key: "command",
        ability: "command",
        label: "flows.ability.command",
        note: "flows.ability.command.note",
        config: { ability: "command", command: { all: [] } },
      },
      {
        key: "test",
        ability: "command",
        label: "flows.palette.test",
        note: "flows.palette.test.note",
        icon: FlaskConical,
        config: { ability: "command", command: { all: [] } },
        does: "Run the project's tests",
      },
    ],
  },
  {
    group: "flows.palette.control",
    entries: [
      {
        key: "gate",
        ability: "gate",
        label: "flows.ability.gate",
        note: "flows.ability.gate.note",
        config: {
          ability: "gate",
          branches: [
            { label: "yes", program: "true" },
            { label: "no", program: "false" },
          ],
        },
      },
      {
        key: "wait",
        ability: "wait",
        label: "flows.ability.wait",
        note: "flows.ability.wait.note",
        config: { ability: "wait", seconds: 60 },
      },
      {
        key: "human",
        ability: "human",
        label: "flows.ability.human",
        note: "flows.ability.human.note",
        config: { ability: "human", mode: "approve" },
      },
    ],
  },
  {
    group: "flows.palette.actions",
    entries: [
      {
        key: "pr",
        ability: "git",
        label: "flows.palette.pr",
        note: "flows.palette.pr.note",
        icon: GitPullRequest,
        config: { ability: "git", action: "pr", base: "main" },
      },
      {
        key: "deploy",
        ability: "service",
        label: "flows.palette.deploy",
        note: "flows.palette.deploy.note",
        icon: Cloud,
        config: { ability: "service", door: "cli", command: { all: [] } },
        does: "Deploy with the cloud's own CLI",
      },
      {
        key: "update",
        ability: "service",
        label: "flows.palette.update",
        note: "flows.palette.update.note",
        icon: Zap,
        config: { ability: "service", door: "tracker", action: "comment" },
      },
      {
        key: "subflow",
        ability: "subflow",
        label: "flows.ability.subflow",
        note: "flows.ability.subflow.note",
        config: { ability: "subflow", slug: "" },
      },
    ],
  },
];

/** A step from a palette entry, ready to be placed and described. */
export function newStep(entry: PaletteEntry, id: string, name: string): Step {
  return {
    id,
    name,
    does: entry.does ?? "",
    config: structuredClone(entry.config),
    onError: "stop",
    retries: DEFAULT_RETRIES[entry.ability],
  };
}
