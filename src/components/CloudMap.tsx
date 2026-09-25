import { createElement, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ArrowLeft,
  Boxes,
  ChevronDown,
  ChevronUp,
  Loader2,
  MapPin,
  TriangleAlert,
  Waypoints,
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
import { linksOf, type CloudLink } from "../lib/cloudLinks";
import { readAnswersOf, useCloud, type CloudResource } from "../stores/cloud";

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
 * Honest about its claims, all on screen: the application comes from the
 * basis named in the header - a tag the team wrote, the stack the cloud
 * recorded, the group - and the person can change it; the grey arrows between
 * lanes are the tier flow (`lib/cloudMap.ts` says why); and the coloured ones
 * are measured - one resource's configuration naming another
 * (`lib/cloudLinks.ts`), each listed with where it was found.
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
            account={resources}
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
  account,
  onOpen,
  onBack,
}: {
  app: AppGroup;
  /** Every resource of the account, because a link can reach outside the application. */
  account: CloudResource[];
  onOpen: (resource: CloudResource) => void;
  onBack: () => void;
}) {
  const t = useT();
  const shape = useMemo(() => shapeOf(app), [app]);
  const untagged = app.name === UNTAGGED;
  const links = useLinks(app, account);
  const linked = useMemo(() => new Set(links.flatMap((link) => [link.from, link.to])), [links]);
  const diagram = useRef<HTMLDivElement>(null);

  return (
    // The right padding is the gutter the measured arrows swing through.
    <div ref={diagram} className="relative flex flex-col gap-3 py-4 pr-12 pl-4">
      <div className="flex flex-wrap items-center gap-2">
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
        <h2 className="min-w-40 flex-1 truncate text-[15px] font-semibold">
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
        <TraceButton app={app} />
      </div>

      {/* Three lanes, top to bottom, the same shape for every application - so
          the picture is learnt once and read thereafter. Stacked rather than
          side by side because this panel shares its width with the file tree
          and the chat: measured 2026-09-09, three columns in 460 px truncated
          every lane name to "NƠI ..." and every resource to "Imp...". */}
      {shape.path.map(([tier, nodes], index) => (
        <div key={tier} className="flex flex-col">
          <Lane tier={tier} nodes={nodes} linked={linked} onOpen={onOpen} />
          {index < shape.path.length - 1 && <FlowArrow />}
        </div>
      ))}

      {shape.support.length > 0 && (
        <Lane tier="support" nodes={shape.support} linked={linked} onOpen={onOpen} />
      )}

      <LinkList links={links} account={account} onOpen={onOpen} />
      <p className="text-[11px] text-muted">{t("cloud.flowNote")}</p>
      <LinkArrows links={links} container={diagram} />
    </div>
  );
}

/**
 * The links the panel can already see among this application's resources:
 * whatever their read configuration names, anywhere in the account. Recomputed
 * as answers arrive, so opening a resource's detail adds its links for free.
 */
function useLinks(app: AppGroup, account: CloudResource[]): CloudLink[] {
  const answers = useCloud((s) => s.answers);
  const plans = useCloud((s) => s.plans);
  const tab = useCloud((s) => s.tab);
  return useMemo(
    () => linksOf(readAnswersOf({ answers, plans, tab }, app.resources), account),
    [answers, plans, tab, app, account],
  );
}

/**
 * Reads the whole application's configuration, so its links can be drawn.
 *
 * A button rather than something that happens on open, because it costs a
 * CLI call per resource into somebody's cloud - its tooltip says how many - and
 * a diagram is often opened only to see what an application is made of.
 */
function TraceButton({ app }: { app: AppGroup }) {
  const t = useT();
  const tracing = useCloud((s) => s.tracing);
  const traceLinks = useCloud((s) => s.traceLinks);
  if (tracing !== null) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted">
        <Loader2 size={12} className="animate-spin" />
        {t("cloud.tracing", { done: tracing.done, total: tracing.total })}
      </span>
    );
  }
  return (
    <button
      onClick={() => void traceLinks(app.resources)}
      title={t("cloud.traceHint", { count: app.resources.length })}
      className="flex shrink-0 items-center gap-1.5 rounded border border-line px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-fg"
    >
      <Waypoints size={12} className="text-accent" />
      {t("cloud.trace")}
    </button>
  );
}

/**
 * Every link in words, grouped by the resource whose configuration holds it:
 * the check behind each arrow, and the only place a link to a resource outside
 * this application can be shown at all.
 *
 * Names wrap rather than truncate. The panel is a few hundred pixels wide, and
 * measured on the first real trace, a row of `source -> target -> path` cut
 * every one of them to "Pay…" - a list of links nobody could read.
 */
function LinkList({
  links,
  account,
  onOpen,
}: {
  links: CloudLink[];
  account: CloudResource[];
  onOpen: (resource: CloudResource) => void;
}) {
  const t = useT();
  const byId = useMemo(() => new Map(account.map((resource) => [resource.id, resource])), [account]);
  const bySource = useMemo(() => linksBySource(links), [links]);
  if (links.length === 0) return null;
  return (
    <section className="rounded-xl border border-accent/30 bg-accent-soft/30 p-2.5">
      <header className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] tracking-wide text-accent uppercase">
        <Waypoints size={11} />
        <span className="flex-1">{t("cloud.linksTitle", { count: links.length })}</span>
      </header>
      <ul className="flex flex-col gap-1.5">
        {[...bySource].map(([source, targets]) => (
          <li key={source} className="flex flex-col gap-0.5 px-1 text-[11px]">
            <LinkEnd resource={byId.get(source)} onOpen={onOpen} />
            {targets.map((link) => (
              <div key={link.to} className="flex items-baseline gap-1.5 pl-4">
                <span className="shrink-0 text-accent">→</span>
                <div className="flex min-w-0 flex-col">
                  <LinkEnd resource={byId.get(link.to)} onOpen={onOpen} />
                  <code className="text-[10px] text-muted" title={link.where}>
                    {lastKeyOf(link.where)}
                  </code>
                </div>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The links under the resource whose configuration holds them, in the order
 * they were found. By hand rather than `Map.groupBy`, which the WebKit webviews
 * this runs in on macOS and Linux do not all have yet.
 */
function linksBySource(links: CloudLink[]): Map<string, CloudLink[]> {
  const groups = new Map<string, CloudLink[]>();
  for (const link of links) groups.set(link.from, [...(groups.get(link.from) ?? []), link]);
  return groups;
}

/** One end of a link: the resource's icon and name, opening its detail. */
function LinkEnd({
  resource,
  onOpen,
}: {
  resource: CloudResource | undefined;
  onOpen: (resource: CloudResource) => void;
}) {
  if (resource === undefined) return null;
  return (
    <button
      onClick={() => {
        onOpen(resource);
      }}
      title={resource.kind}
      className="flex min-w-0 items-baseline gap-1 text-left wrap-anywhere hover:text-accent"
    >
      {createElement(iconOfKind(resource.kind), {
        size: 11,
        className: `shrink-0 self-center ${classesOfKind(resource.kind).icon}`,
      })}
      {resource.name}
    </button>
  );
}

/**
 * The last key of where a link was found - `QUEUE_URL` out of
 * `Configuration.Environment.Variables.QUEUE_URL` - which is the part that
 * says what the reference is for; the whole path is its tooltip.
 */
function lastKeyOf(where: string): string {
  return where.split(".").at(-1) ?? where;
}

/** One arrow as drawn: from the right edge of one row to the left edge of another. */
interface Arrow {
  key: string;
  path: string;
}

/**
 * The measured links as arrows over the diagram, between the rows of the two
 * resources - or the header of the box holding one, when its row is folded
 * away or scrolled out of its box.
 *
 * An SVG laid over the diagram and positioned from the rows' own boxes, re-laid
 * whenever the diagram resizes or a box scrolls: the lanes wrap with the
 * panel's width, and an arrow drawn from coordinates of a previous layout would
 * point at nothing.
 */
function LinkArrows({
  links,
  container,
}: {
  links: CloudLink[];
  container: RefObject<HTMLDivElement | null>;
}) {
  const [arrows, setArrows] = useState<Arrow[]>([]);
  useLayoutEffect(() => {
    const root = container.current;
    if (root === null) return;
    const lay = () => {
      setArrows(arrowsFor(links, root));
    };
    lay();
    const resized = new ResizeObserver(lay);
    resized.observe(root);
    root.addEventListener("scroll", lay, true);
    return () => {
      resized.disconnect();
      root.removeEventListener("scroll", lay, true);
    };
  }, [links, container]);
  if (arrows.length === 0) return null;
  return (
    <svg className="pointer-events-none absolute inset-0 size-full overflow-visible text-accent" aria-hidden>
      <defs>
        <marker
          id="link-head"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
        </marker>
      </defs>
      {arrows.map((arrow) => (
        <path
          key={arrow.key}
          d={arrow.path}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeOpacity="0.85"
          markerEnd="url(#link-head)"
        />
      ))}
    </svg>
  );
}

/**
 * How far past the wider of two rows an arrow swings out. Both ends sit on the
 * rows' right edges and the curve runs in the gutter beside the boxes: the
 * lanes are stacked, so an arrow drawn straight from one row to another
 * crossed every name between them (measured on the first real trace).
 */
const ARROW_SWING_PX = 36;

function arrowsFor(links: CloudLink[], root: HTMLElement): Arrow[] {
  const origin = root.getBoundingClientRect();
  return links.flatMap((link) => {
    const from = anchorOf(root, link.from);
    const to = anchorOf(root, link.to);
    if (from === null || to === null || from === to) return [];
    const a = edgeOf(from, origin);
    const b = edgeOf(to, origin);
    const swing = Math.max(a.right, b.right) + ARROW_SWING_PX;
    const rise = (b.middle - a.middle) / 4;
    return [
      {
        key: `${link.from}>${link.to}`,
        path: [
          `M${String(a.right)},${String(a.middle)}`,
          `C${String(swing)},${String(a.middle + rise)}`,
          `${String(swing)},${String(b.middle - rise)}`,
          `${String(b.right)},${String(b.middle)}`,
        ].join(" "),
      },
    ];
  });
}

/** An element's right edge and vertical middle, in the diagram's own coordinates. */
function edgeOf(element: HTMLElement, origin: DOMRect): { right: number; middle: number } {
  const box = element.getBoundingClientRect();
  return { right: box.right - origin.left, middle: box.top + box.height / 2 - origin.top };
}

/**
 * The element an arrow for this resource attaches to: its own row while that
 * row is on screen inside its box, the box's header otherwise; null for a
 * resource this diagram does not draw.
 */
function anchorOf(root: HTMLElement, id: string): HTMLElement | null {
  const row = root.querySelector<HTMLElement>(`[data-resource-id="${CSS.escape(id)}"]`);
  if (row !== null) {
    const list = row.parentElement;
    const shown = list === null ? row.getBoundingClientRect() : list.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    if (box.bottom > shown.top && box.top < shown.bottom) return row;
  }
  const kind =
    row?.closest<HTMLElement>("[data-kind]") ??
    root.querySelector<HTMLElement>(`[data-holds~="${CSS.escape(id)}"]`);
  return kind?.querySelector<HTMLElement>("[data-kind-head]") ?? null;
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
  linked,
  onOpen,
}: {
  tier: Tier;
  nodes: KindNode[];
  /** Resources a measured link touches, drawn first in their box so an arrow can reach them. */
  linked: ReadonlySet<string>;
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
          <KindBox
            key={node.kind}
            kind={node.kind}
            resources={node.resources}
            linked={linked}
            onOpen={onOpen}
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
  linked,
  onOpen,
}: {
  kind: string;
  resources: CloudResource[];
  linked: ReadonlySet<string>;
  onOpen: (resource: CloudResource) => void;
}) {
  const t = useT();
  const warmPlan = useCloud((s) => s.warmPlan);
  const [open, setOpen] = useState(false);
  const classes = classesOfKind(kind);
  const ordered = useMemo(
    () => [
      ...resources.filter((one) => linked.has(one.id)),
      ...resources.filter((one) => !linked.has(one.id)),
    ],
    [resources, linked],
  );
  const shown = open ? ordered : ordered.slice(0, NAMES_SHOWN);
  const hidden = resources.length - shown.length;

  return (
    <div
      data-kind={kind}
      data-holds={resources.map((one) => one.id).join(" ")}
      className="flex min-w-56 flex-1 flex-col rounded-lg border border-line bg-panel shadow-sm"
    >
      <div data-kind-head className={`flex items-center gap-2 rounded-t-lg px-2 py-1.5 ${classes.chip}`}>
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
            data-resource-id={resource.id}
            onClick={() => {
              onOpen(resource);
            }}
            onPointerEnter={() => {
              warmPlan(resource);
            }}
            title={`${resource.name}${resource.location === "" ? "" : ` · ${resource.location}`}`}
            className="flex items-center gap-1.5 px-2 py-0.5 text-left hover:bg-elevated"
          >
            {linked.has(resource.id) && <span className="size-1.5 shrink-0 rounded-full bg-accent" />}
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
