import { createElement, useMemo, useState } from "react";
import {
  ArrowLeft,
  Boxes,
  ChevronDown,
  ChevronUp,
  MapPin,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useT } from "../i18n";
import type { TranslationKey } from "../i18n/en";
import { classesOfKind, iconOfKind, shortKind, type Tier } from "../lib/cloudIcons";
import {
  mapOf,
  nodesOf,
  regionsOf,
  sameBasis,
  shapeOf,
  UNTAGGED,
  type AppGroup,
  type Basis,
  type BasisOption,
  type KindNode,
} from "../lib/cloudMap";
import { useCloud, type CloudResource } from "../stores/cloud";

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
  onKind,
}: {
  resources: CloudResource[];
  /** The person's own choice, if they made one. */
  basis: Basis | undefined;
  onBasis: (basis: Basis) => void;
  onOpen: (resource: CloudResource) => void;
  /** Shows every resource of one type, in the list where they can be opened. */
  onKind: (kind: string) => void;
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
          <EstateOverview resources={resources} apps={map.apps} onFocus={setFocusName} onKind={onKind} />
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
 * The account before an application is picked: what it is built from, and what
 * it could not attribute to anything.
 *
 * It used to be one card per application, each card the same list of kinds -
 * with 72 applications made mostly of Lambda that is 72 cards saying the same
 * thing, beside a rail already listing every one of them (reported 2026-09-09:
 * "application cũng khó nhìn, nhìn vô éo hiểu gì"). The rail answers which
 * applications there are and how big they are, so this pane answers only what
 * the rail cannot: how much of the account nothing claims, which services it
 * runs on, and where they are. Nothing here repeats the rail.
 */
function EstateOverview({
  resources,
  apps,
  onFocus,
  onKind,
}: {
  resources: CloudResource[];
  apps: AppGroup[];
  onFocus: (name: string) => void;
  onKind: (kind: string) => void;
}) {
  const t = useT();
  const services = useMemo(() => nodesOf(resources), [resources]);
  const regions = useMemo(() => regionsOf(resources), [resources]);
  const unattributed = apps.find((app) => app.name === UNTAGGED);
  const mostOfAKind = services.at(0)?.resources.length ?? 1;

  return (
    <div className="flex flex-col gap-5 p-4">
      {unattributed !== undefined && (
        <button
          onClick={() => {
            onFocus(unattributed.name);
          }}
          className="flex items-start gap-2 rounded-lg border border-dashed border-warn/40 bg-warn/5 px-3 py-2 text-left hover:border-warn"
        >
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warn" />
          <span className="text-[11.5px] text-muted">
            {t("cloud.gapRow", {
              count: unattributed.resources.length,
              share: Math.round((unattributed.resources.length / resources.length) * 100),
            })}
          </span>
        </button>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] tracking-wide text-muted uppercase">{t("cloud.builtFrom")}</h3>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-6 gap-y-1">
          {services.slice(0, 24).map((node) => (
            <button
              key={node.kind}
              onClick={() => {
                onKind(node.kind);
              }}
              title={t("cloud.openKind", { kind: shortKind(node.kind) })}
              className="flex items-center gap-2 rounded px-1 text-left hover:bg-elevated hover:text-fg"
            >
              <ServiceBadge kind={node.kind} />
              <span className="min-w-0 flex-1 truncate" title={node.kind}>
                {shortKind(node.kind)}
              </span>
              <span className="flex h-2 w-20 shrink-0 items-center">
                <span
                  className={`h-full rounded-sm ${classesOfKind(node.kind).bar}`}
                  style={barWidth(node.resources.length, mostOfAKind)}
                />
              </span>
              <span className="w-12 shrink-0 text-right tabular-nums text-muted">
                {node.resources.length}
              </span>
            </button>
          ))}
        </div>
        {services.length > 24 && (
          <p className="text-[11px] text-muted">{t("cloud.moreKinds", { count: services.length - 24 })}</p>
        )}
      </section>

      {regions.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] tracking-wide text-muted uppercase">{t("cloud.regionsHere")}</h3>
          <div className="flex flex-wrap gap-1.5">
            {regions.map((region) => (
              <span
                key={region.name}
                className="flex items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[11px]"
              >
                <MapPin size={10} className="shrink-0 text-muted" />
                {region.name}
                <span className="tabular-nums text-muted">{region.count}</span>
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** A bar's width as a share of the biggest one, never invisible. */
function barWidth(value: number, largest: number): { width: string } {
  const share = largest === 0 ? 0 : value / largest;
  return { width: `${String(Math.max(2, share * 100))}%` };
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
 * One application as a diagram: the request path left to right, always.
 *
 * The lanes are drawn whether the application has them or not, and that is the
 * change that made this readable (reported 2026-09-09). An application of 31
 * functions and nothing else used to be one wide box with 31 names in it - no
 * shape, no arrow, indistinguishable from the resource list it was supposed to
 * replace. Now the same application is three lanes with two of them saying
 * "nothing here", which is a fact worth seeing: nothing takes requests, nothing
 * holds state, it is a back-end that runs on a trigger.
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
  const shape = useMemo(() => shapeOf(app), [app]);
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
        {shape.regions.slice(0, 3).map((region) => (
          <span key={region.name} className="flex shrink-0 items-center gap-1 text-[11px] text-muted">
            <MapPin size={10} />
            {region.name}
          </span>
        ))}
      </div>

      {/* Three lanes, top to bottom, the same shape for every application - so
          the picture is learnt once and read thereafter. Stacked rather than
          side by side because this panel shares its width with the file tree
          and the chat: measured 2026-09-09, three columns in 460 px truncated
          every lane name to "NƠI ..." and every resource to "Imp...". */}
      {shape.path.map(([tier, nodes], index) => (
        <div key={tier} className="flex flex-col">
          <Lane tier={tier} nodes={nodes} onOpen={onOpen} />
          {index < shape.path.length - 1 && <FlowArrow />}
        </div>
      ))}

      {shape.support.length > 0 && <Lane tier="support" nodes={shape.support} onOpen={onOpen} />}

      <p className="text-[11px] text-muted">{t("cloud.flowNote")}</p>
    </div>
  );
}

/** The arrow between two lanes: the direction a request travels. */
function FlowArrow() {
  return (
    <svg width="24" height="22" viewBox="0 0 24 22" className="my-1 self-center text-line" aria-hidden>
      <line x1="12" y1="1" x2="12" y2="14" stroke="currentColor" strokeWidth="1.5" />
      <polygon points="6,13 12,21 18,13" fill="currentColor" />
    </svg>
  );
}

/** One lane of the diagram: a box per kind, or a word for having none. */
function Lane({
  tier,
  nodes,
  onOpen,
}: {
  tier: Tier;
  nodes: KindNode[];
  onOpen: (resource: CloudResource) => void;
}) {
  const t = useT();
  const total = nodes.reduce((sum, node) => sum + node.resources.length, 0);

  // An empty lane is one thin line. It still has to be there - "nothing takes
  // requests" is the fact the picture is for - but it must not take the room
  // of a lane that holds something.
  if (nodes.length === 0) {
    return (
      <section className="flex items-center gap-1.5 rounded-lg border border-dashed border-line/60 px-2.5 py-1.5 text-[10px] tracking-wide text-muted uppercase">
        <span className="size-1.5 rounded-full bg-line" />
        <span className="min-w-0 truncate">{t(TIER_LABELS[tier])}</span>
        <span className="normal-case opacity-70">- {t("cloud.laneEmpty")}</span>
      </section>
    );
  }

  return (
    <section className="flex min-w-0 flex-col rounded-xl border border-dashed border-line bg-bg/40 p-2.5">
      <header className="mb-2 flex items-center gap-1.5 px-1 text-[10px] tracking-wide text-muted uppercase">
        <span className={`size-1.5 rounded-full ${TIER_BAR[tier]}`} />
        <span className="min-w-0 flex-1 truncate">{t(TIER_LABELS[tier])}</span>
        <span className="tabular-nums">{total}</span>
      </header>
      <div className="flex flex-wrap gap-2">
        {nodes.map((node) => (
          <KindBox key={node.kind} kind={node.kind} resources={node.resources} onOpen={onOpen} />
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
}: {
  kind: string;
  resources: CloudResource[];
  onOpen: (resource: CloudResource) => void;
}) {
  const t = useT();
  const warmPlan = useCloud((s) => s.warmPlan);
  const [open, setOpen] = useState(false);
  const classes = classesOfKind(kind);
  const shown = open ? resources : resources.slice(0, NAMES_SHOWN);
  const hidden = resources.length - shown.length;

  return (
    <div className="flex min-w-56 flex-1 flex-col rounded-lg border border-line bg-panel shadow-sm">
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
            onPointerEnter={() => {
              warmPlan(resource);
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
