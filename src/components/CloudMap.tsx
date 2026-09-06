import { createElement, useMemo, useState } from "react";
import { ArrowLeft, Boxes, ChevronDown, ChevronUp, TriangleAlert, type LucideIcon } from "lucide-react";
import { useT } from "../i18n";
import type { TranslationKey } from "../i18n/en";
import { classesOfKind, iconOfKind, shortKind, type Tier } from "../lib/cloudIcons";
import {
  mapOf,
  nodesOf,
  sameBasis,
  UNTAGGED,
  type AppGroup,
  type Basis,
  type BasisOption,
} from "../lib/cloudMap";
import type { CloudResource } from "../stores/cloud";

/**
 * What is deployed in one account, drawn as applications rather than listed.
 *
 * Two levels, because that is how anyone reads an estate. First **all
 * applications at once**: one card each, saying how big it is and what it is
 * made of, so ten applications are ten cards and not six thousand rows. Then
 * **one application as a diagram**: its tiers as lanes left to right - what
 * faces the world, what runs the code, what holds the state - with the flow
 * drawn between them, and every KIND of resource as one box carrying its count.
 * Seven hundred functions are one box that says 787; the instances are inside
 * it, one click from their own detail. That is how an architecture diagram is
 * drawn by hand, and it is the only way this many resources become a picture.
 *
 * Honest about its two claims, both on screen: the application comes from the
 * basis named in the header - a tag the team wrote, the stack the cloud
 * recorded, the group - and the person can change it; and the arrows are the
 * tier flow, not measured dependencies (`lib/cloudMap.ts` says why).
 */
export function CloudMap({
  resources,
  basis,
  onBasis,
  onOpen,
}: {
  resources: CloudResource[];
  /** The person's own choice, if they made one. */
  basis: Basis | undefined;
  onBasis: (basis: Basis) => void;
  onOpen: (resource: CloudResource) => void;
}) {
  const t = useT();
  const map = useMemo(() => mapOf(resources, basis), [resources, basis]);
  const [focusName, setFocusName] = useState<string | null>(null);
  const focus = map.apps.find((app) => app.name === focusName) ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex flex-col gap-1.5 border-b border-line px-3 py-2">
          <div className="flex items-center gap-1.5">
            <Boxes size={13} className="text-accent" />
            <span className="font-semibold">{t("cloud.appCount", { count: map.apps.length })}</span>
          </div>
          <BasisPicker options={map.options} basis={map.basis} onBasis={onBasis} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          <AppRow
            icon={Boxes}
            label={t("cloud.allApps")}
            count={resources.length}
            active={focus === null}
            onClick={() => {
              setFocusName(null);
            }}
          />
          {map.apps.map((app) => (
            <AppRow
              key={app.name}
              icon={app.name === UNTAGGED ? TriangleAlert : Boxes}
              label={app.name === UNTAGGED ? t("cloud.appUnnamed") : app.name}
              count={app.resources.length}
              active={focus?.name === app.name}
              muted={app.name === UNTAGGED}
              onClick={() => {
                setFocusName(app.name);
              }}
              shares={tierShares(app)}
            />
          ))}
        </div>
      </aside>

      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {focus === null ? (
          <AppGrid apps={map.apps} onFocus={setFocusName} />
        ) : (
          <AppDiagram
            app={focus}
            onOpen={onOpen}
            onBack={() => {
              setFocusName(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * What an application is, chosen by the person from what the data offers.
 *
 * A native select rather than a custom menu: it is one choice among a handful,
 * keyboard-reachable for free, and every option names what it would do -
 * which tag, how many resources it covers, how many applications it makes.
 */
function BasisPicker({
  options,
  basis,
  onBasis,
}: {
  options: BasisOption[];
  basis: Basis;
  onBasis: (basis: Basis) => void;
}) {
  const t = useT();
  if (options.length === 0) return <span className="text-[11px] text-muted">{t("cloud.basisNone")}</span>;
  const current = options.findIndex((option) => sameBasis(option.basis, basis));
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-muted">
      <span className="shrink-0">{t("cloud.basisLabel")}</span>
      <select
        value={current}
        onChange={(event) => {
          const picked = options.at(Number(event.target.value));
          if (picked !== undefined) onBasis(picked.basis);
        }}
        className="min-w-0 flex-1 rounded border border-line bg-elevated px-1.5 py-0.5 text-fg outline-none focus:border-accent"
      >
        {options.map((option, index) => (
          <option key={index} value={index}>
            {basisName(option.basis, t)} ·{" "}
            {t("cloud.basisStats", { covered: option.covered, apps: option.apps })}
          </option>
        ))}
      </select>
    </label>
  );
}

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** What a basis is called, in the words of the cloud that recorded it. */
export function basisName(basis: Basis, t: Translate): string {
  switch (basis.kind) {
    case "tag":
      return t("cloud.basisTag", { key: basis.key });
    case "stack":
      return t("cloud.basisStack");
    case "group":
      return t("cloud.basisGroup");
    case "none":
      return t("cloud.basisNone");
  }
}

/** One application in the list: its name, its size, and the shape of its tiers. */
function AppRow({
  icon,
  label,
  count,
  active,
  muted = false,
  onClick,
  shares,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
  active: boolean;
  muted?: boolean;
  onClick: () => void;
  shares?: [Tier, number][];
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full flex-col gap-1 px-3 py-1.5 text-left hover:bg-elevated ${
        active ? "bg-elevated" : ""
      }`}
    >
      <span className="flex w-full items-center gap-1.5">
        {createElement(icon, {
          size: 13,
          className: `shrink-0 ${muted ? "text-warn" : active ? "text-accent" : "text-muted"}`,
        })}
        <span className={`min-w-0 flex-1 truncate ${active ? "font-semibold text-fg" : ""}`}>{label}</span>
        <span className="shrink-0 rounded-full bg-bg px-1.5 py-px text-[10px] tabular-nums text-muted">
          {count}
        </span>
      </span>
      {shares !== undefined && (
        <span className="flex h-1 w-full overflow-hidden rounded-full bg-bg">
          {shares.map(([tier, share]) => (
            <span key={tier} className={TIER_BAR[tier]} style={{ width: `${String(share * 100)}%` }} />
          ))}
        </span>
      )}
    </button>
  );
}

/** How much of an application each tier is, for the bar under its name. */
function tierShares(app: AppGroup): [Tier, number][] {
  return app.tiers.map(([tier, owned]) => [tier, owned.length / app.resources.length]);
}

/** The colour a tier takes in the bar; static class names so Tailwind sees them. */
const TIER_BAR: Record<Tier, string> = {
  edge: "bg-svc-network",
  compute: "bg-svc-compute",
  data: "bg-svc-data",
  support: "bg-svc-other",
};

export const TIER_LABELS: Record<Tier, TranslationKey> = {
  edge: "cloud.tierEdge",
  compute: "cloud.tierCompute",
  data: "cloud.tierData",
  support: "cloud.tierSupport",
};

/**
 * Every application at once, each card saying what it is made of.
 *
 * A card shows kinds and counts per tier rather than resource names: the
 * question at this level is "what does this estate consist of", and the names
 * are one click further in.
 */
function AppGrid({ apps, onFocus }: { apps: AppGroup[]; onFocus: (name: string) => void }) {
  const t = useT();
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3 p-3">
      {apps.map((app) => {
        const untagged = app.name === UNTAGGED;
        return (
          <button
            key={app.name}
            onClick={() => {
              onFocus(app.name);
            }}
            className={`flex flex-col rounded-xl border bg-panel text-left transition-colors hover:border-accent ${
              untagged ? "border-dashed border-line" : "border-line"
            }`}
          >
            <span className="flex items-center gap-2 border-b border-line px-3 py-2">
              {untagged ? (
                <TriangleAlert size={14} className="shrink-0 text-warn" />
              ) : (
                <Boxes size={14} className="shrink-0 text-accent" />
              )}
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                {untagged ? t("cloud.appUnnamed") : app.name}
              </span>
              <span className="shrink-0 rounded-full bg-elevated px-2 py-0.5 text-[10px] tabular-nums text-muted">
                {t("cloud.resourceCount", { count: app.resources.length })}
              </span>
            </span>
            <span className="flex flex-col gap-1.5 px-3 py-2">
              {app.tiers.map(([tier, owned]) => (
                <span key={tier} className="flex items-start gap-2">
                  <span className="w-24 shrink-0 pt-0.5 text-[10px] tracking-wide text-muted uppercase">
                    {t(TIER_LABELS[tier])}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-wrap gap-1">
                    {nodesOf(owned).map((node) => (
                      <KindChip key={node.kind} kind={node.kind} count={node.resources.length} />
                    ))}
                  </span>
                </span>
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A kind and how many of it, as one small coloured chip. */
export function KindChip({ kind, count }: { kind: string; count: number }) {
  const classes = classesOfKind(kind);
  return (
    <span
      title={kind}
      className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] ${classes.chip}`}
    >
      {createElement(iconOfKind(kind), { size: 11, className: `shrink-0 ${classes.icon}` })}
      <span className="max-w-36 truncate">{shortKind(kind)}</span>
      <span className="tabular-nums opacity-70">{count}</span>
    </span>
  );
}

/**
 * A resource type as a coloured badge.
 *
 * The one visual decision that makes a list of a thousand resources readable:
 * the colour says what family it is before a word has been read. Shared so the
 * map, the list and the detail cannot drift apart.
 */
export function ServiceBadge({ kind, size = 4 }: { kind: string; size?: 4 | 5 | 6 }) {
  const classes = classesOfKind(kind);
  const box = size === 6 ? "size-7 rounded-lg" : size === 5 ? "size-5 rounded" : "size-4 rounded";
  const glyph = size === 6 ? 16 : size === 5 ? 13 : 11;
  return (
    <span className={`flex ${box} shrink-0 items-center justify-center ${classes.chip}`}>
      {createElement(iconOfKind(kind), { size: glyph, className: classes.icon })}
    </span>
  );
}

/**
 * One application as a diagram: lanes for its tiers, boxes for its kinds.
 *
 * The three request-path tiers run left to right with the flow drawn between
 * them; what surrounds the application - monitoring, identity, registries -
 * sits in a band underneath, because it is not on the path a request takes.
 * A lane the application does not have is left out rather than drawn empty,
 * so a batch job with no edge is two lanes, not three with a hole.
 */
function AppDiagram({
  app,
  onOpen,
  onBack,
}: {
  app: AppGroup;
  onOpen: (resource: CloudResource) => void;
  onBack: () => void;
}) {
  const t = useT();
  const path = app.tiers.filter(([tier]) => tier !== "support");
  const support = app.tiers.find(([tier]) => tier === "support");
  const untagged = app.name === UNTAGGED;

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          title={t("cloud.allApps")}
          className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
        >
          <ArrowLeft size={14} />
        </button>
        {untagged ? (
          <TriangleAlert size={16} className="shrink-0 text-warn" />
        ) : (
          <Boxes size={16} className="shrink-0 text-accent" />
        )}
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">
          {untagged ? t("cloud.appUnnamed") : app.name}
        </h2>
        <span className="shrink-0 text-muted">
          {t("cloud.resourceCount", { count: app.resources.length })}
        </span>
      </div>

      {path.length > 0 && (
        <div className="flex items-stretch">
          {path.map(([tier, owned], index) => (
            <div key={tier} className="flex min-w-0 flex-1 items-stretch">
              <Lane tier={tier} resources={owned} onOpen={onOpen} />
              {index < path.length - 1 && <FlowArrow />}
            </div>
          ))}
        </div>
      )}

      {support !== undefined && <Lane tier="support" resources={support[1]} onOpen={onOpen} horizontal />}

      <p className="text-[11px] text-muted">{t("cloud.flowNote")}</p>
    </div>
  );
}

/** The arrow between two lanes: the direction a request travels. */
function FlowArrow() {
  return (
    <svg width="32" height="24" viewBox="0 0 32 24" className="shrink-0 self-center text-muted" aria-hidden>
      <line x1="2" y1="12" x2="22" y2="12" stroke="currentColor" strokeWidth="1.5" />
      <polygon points="21,6 31,12 21,18" fill="currentColor" />
    </svg>
  );
}

/** One tier of one application, holding a box per kind. */
function Lane({
  tier,
  resources,
  onOpen,
  horizontal = false,
}: {
  tier: Tier;
  resources: CloudResource[];
  onOpen: (resource: CloudResource) => void;
  horizontal?: boolean;
}) {
  const t = useT();
  const nodes = nodesOf(resources);
  return (
    <section className="flex min-w-0 flex-1 flex-col rounded-xl border border-dashed border-line bg-bg/40 p-2.5">
      <header className="mb-2 flex items-center gap-1.5 px-1 text-[10px] tracking-wide text-muted uppercase">
        <span className={`size-1.5 rounded-full ${TIER_BAR[tier]}`} />
        <span className="min-w-0 flex-1 truncate">{t(TIER_LABELS[tier])}</span>
        <span className="tabular-nums">{resources.length}</span>
      </header>
      <div className={horizontal ? "flex flex-wrap gap-2" : "flex flex-col gap-2"}>
        {nodes.map((node) => (
          <KindBox
            key={node.kind}
            kind={node.kind}
            resources={node.resources}
            onOpen={onOpen}
            wide={!horizontal}
          />
        ))}
      </div>
    </section>
  );
}

/** How many instances a box shows before it folds the rest behind a count. */
const NAMES_SHOWN = 6;

/**
 * One kind of resource as one box: what an architecture diagram draws as a
 * component, with the count on it and the instances inside.
 */
function KindBox({
  kind,
  resources,
  onOpen,
  wide,
}: {
  kind: string;
  resources: CloudResource[];
  onOpen: (resource: CloudResource) => void;
  wide: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const classes = classesOfKind(kind);
  const shown = open ? resources : resources.slice(0, NAMES_SHOWN);
  const hidden = resources.length - shown.length;

  return (
    <div className={`flex flex-col rounded-lg border border-line bg-panel shadow-sm ${wide ? "" : "w-56"}`}>
      <div className={`flex items-center gap-2 rounded-t-lg px-2 py-1.5 ${classes.chip}`}>
        {createElement(iconOfKind(kind), { size: 14, className: `shrink-0 ${classes.icon}` })}
        <span className="min-w-0 flex-1 truncate font-semibold" title={kind}>
          {shortKind(kind)}
        </span>
        <span className="shrink-0 rounded-full bg-panel px-1.5 py-px text-[10px] tabular-nums">
          {resources.length}
        </span>
      </div>
      <div className={`flex flex-col py-1 ${open ? "max-h-64 overflow-y-auto" : ""}`}>
        {shown.map((resource) => (
          <button
            key={resource.id}
            onClick={() => {
              onOpen(resource);
            }}
            title={`${resource.name}${resource.location === "" ? "" : ` · ${resource.location}`}`}
            className="flex items-center gap-1.5 px-2 py-0.5 text-left hover:bg-elevated"
          >
            <span className="min-w-0 flex-1 truncate">{resource.name}</span>
          </button>
        ))}
        {(hidden > 0 || open) && resources.length > NAMES_SHOWN && (
          <button
            onClick={() => {
              setOpen(!open);
            }}
            className="flex items-center gap-1 px-2 py-0.5 text-left text-[11px] text-accent hover:underline"
          >
            {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            {open ? t("cloud.showFewer") : t("cloud.andMore", { count: hidden })}
          </button>
        )}
      </div>
    </div>
  );
}
