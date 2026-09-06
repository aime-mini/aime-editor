import { createElement, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Cloud as CloudIcon,
  Copy,
  Download,
  ExternalLink,
  Layers,
  ListTree,
  Loader2,
  LogIn,
  MapPin,
  Network,
  Radar,
  RefreshCw,
  Rocket,
  Search,
  Star,
  TriangleAlert,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useT } from "../i18n";
import type { TranslationKey } from "../i18n/en";
import { GROUPINGS, iconOfGrouping, shortKind, type Grouping } from "../lib/cloudIcons";
import { commandLabel } from "../lib/cloudReads";
import { DEPLOYABLE } from "../lib/deploy";
import { CloudDetail, CopyButton, Note } from "./CloudDetail";
import { CloudMap, KindChip, ServiceBadge } from "./CloudMap";
import { DeployPane } from "./DeployPane";
import {
  slotOf,
  useCloud,
  type CloudAccount,
  type CloudResource,
  type CloudStatus,
  type CloudViewMode,
  type ResourceState,
} from "../stores/cloud";
import { useDeploy } from "../stores/deploy";
import { useLayout } from "../stores/layout";
import { useWorkspace } from "../stores/workspace";

/**
 * The cloud panel: a console, not a settings page.
 *
 * Three regions, the way every cloud console and both VS Code cloud extensions
 * lay it out: the clouds as tabs across the top, the ACCOUNTS that cloud's CLI
 * holds down the left - measured on this machine, `az` held four subscriptions
 * across two users and `aws` held 28 profiles, so the account list is a real
 * navigation surface and not a dropdown - and the selected account filling the
 * rest. An account opens as its applications (`CloudMap`) by default, because
 * "which of these ten apps is this" is the question a list cannot answer, and
 * as a grouped list when a person is looking for one resource by name.
 *
 * Reaching the network stays as rare as it was: accounts come from what the CLI
 * keeps on disk, an account's resources are fetched when it is selected and then
 * kept, and one resource's settings when that resource is opened. The states
 * with no rows in them are drawn as states with the one action that fixes them,
 * and a sign-in that needs a browser opens it from Aime's own process so it
 * lands in front of the editor rather than behind it.
 */
export function CloudView() {
  const { clouds, ready, tab, refresh, openTab, watchSignIns, detail } = useCloud();
  const closeCloud = useWorkspace((s) => s.closeCloud);
  const t = useT();

  useEffect(() => {
    void refresh();
    void watchSignIns();
  }, [refresh, watchSignIns]);

  useEffect(() => {
    if (ready) void openTab(tab);
  }, [ready, tab, openTab]);

  const cloud = clouds.find((candidate) => candidate.id === tab);

  return (
    <div className="flex h-full flex-col bg-bg text-[12px]">
      <header className="flex items-center gap-3 border-b border-line px-3">
        <span className="flex items-center gap-1.5 py-2 font-semibold">
          <CloudIcon size={14} className="shrink-0 text-accent" />
          {t("cloud.panelTitle")}
        </span>
        <nav className="flex gap-1">
          {clouds.map((candidate) => (
            <CloudTab
              key={candidate.id}
              cloud={candidate}
              active={candidate.id === tab}
              onClick={() => void openTab(candidate.id)}
            />
          ))}
        </nav>
        <span className="flex-1" />
        <button
          onClick={closeCloud}
          title={t("cloud.close")}
          className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
        >
          <X size={13} />
        </button>
      </header>

      {cloud === undefined ? (
        <EmptyState icon={Loader2} spin title={t("cloud.looking")} />
      ) : (
        <CloudBody cloud={cloud} />
      )}

      {/* Over the top, not instead of: the map stays where it was, so closing
          the detail does not mean finding your place again. */}
      {detail !== null && <CloudDetail resource={detail} />}
    </div>
  );
}

/** One cloud's tab: its name and a dot for its state. */
function CloudTab({ cloud, active, onClick }: { cloud: CloudStatus; active: boolean; onClick: () => void }) {
  const t = useT();
  const probing = useCloud((s) => s.probing);
  const tone =
    cloud.signedIn === true
      ? "bg-ok"
      : cloud.signedIn === false
        ? "bg-danger"
        : cloud.installed
          ? "bg-muted"
          : "bg-muted opacity-40";
  const state = !cloud.installed
    ? t("cloud.notInstalled")
    : cloud.signedIn === true
      ? (cloud.account ?? "")
      : cloud.signedIn === false
        ? t("cloud.signInFirst")
        : t("cloud.signedInUnknown");
  return (
    <button
      onClick={onClick}
      title={state}
      className={`flex items-center gap-1.5 border-b-2 px-3 py-2 ${
        active ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"
      }`}
    >
      {probing ? (
        <Loader2 size={10} className="animate-spin text-muted" />
      ) : (
        <span className={`size-1.5 rounded-full ${tone}`} />
      )}
      {cloud.label}
    </button>
  );
}

/** One cloud: its accounts down the left, the selected one filling the rest. */
function CloudBody({ cloud }: { cloud: CloudStatus }) {
  const accounts = useCloud((s) => s.accounts[cloud.id]);
  const selectedId = useCloud((s) => s.selected[cloud.id]);
  const t = useT();

  if (accounts === undefined) return <EmptyState icon={Loader2} spin title={t("cloud.looking")} />;
  if (accounts.length === 0) return <NoAccounts cloud={cloud} />;

  const account = accounts.find((candidate) => candidate.id === selectedId);

  return (
    <div className="flex min-h-0 flex-1">
      <AccountRail cloud={cloud} accounts={accounts} selectedId={selectedId} />
      {account === undefined ? (
        <EmptyState icon={Layers} title={t("cloud.pickAccount")} />
      ) : (
        <AccountPane cloud={cloud} account={account} />
      )}
    </div>
  );
}

/** Above this many accounts the rail gets a filter box. */
const RAIL_FILTER_FROM = 8;

/**
 * What each cloud calls the unit a command is scoped by, which is what the
 * rail lists: subscriptions, profiles, projects.
 */
const TALLY_LABELS: Record<string, TranslationKey | undefined> = {
  azure: "cloud.tallySubscriptions",
  aws: "cloud.tallyProfiles",
  gcp: "cloud.tallyProjects",
  supabase: "cloud.tallyProjects",
};

/** What each cloud calls the grouping column of a resource. */
const GROUP_LABELS: Record<string, TranslationKey | undefined> = {
  azure: "cloud.field.group",
  aws: "cloud.field.account",
  gcp: "cloud.field.project",
  supabase: "cloud.field.project",
};

/**
 * Clouds whose CLI holds a default account of its own that the star can set:
 * `az account set`, `gcloud config set project`. AWS chooses a profile per
 * command and has no such default (see `cloud_set_account`).
 */
const HAS_CLI_DEFAULT: ReadonlySet<string> = new Set(["azure", "gcp"]);

/**
 * The accounts one cloud's CLI holds, under whoever owns them.
 *
 * Two levels because the data has two: `az account list` returns subscriptions
 * that belong to different signed-in users, and `gcloud` lists projects per
 * signed-in Google account; listing those flat throws away the one fact that
 * tells them apart. AWS has no such level locally - a profile is a name in a
 * config file - so its profiles list directly.
 */
function AccountRail({
  cloud,
  accounts,
  selectedId,
}: {
  cloud: CloudStatus;
  accounts: CloudAccount[];
  selectedId: string | undefined;
}) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown =
    needle === ""
      ? accounts
      : accounts.filter((account) =>
          `${account.label} ${account.detail} ${account.owner}`.toLowerCase().includes(needle),
        );
  const owners = useMemo(() => byOwner(shown), [shown]);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2 text-[10px] tracking-wide text-muted uppercase">
        <Layers size={11} />
        <span className="flex-1">{t(TALLY_LABELS[cloud.id] ?? "cloud.tallySubscriptions")}</span>
        <span className="tabular-nums">{accounts.length}</span>
      </div>
      {accounts.length >= RAIL_FILTER_FROM && (
        <label className="flex items-center gap-1.5 border-b border-line px-3 py-1.5">
          <Search size={11} className="shrink-0 text-muted" />
          <input
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
            placeholder={t("cloud.filterAccounts")}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
          />
        </label>
      )}
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {owners.map(([owner, owned]) => (
          <div key={owner}>
            {owner !== "" && (
              <div className="flex items-center gap-1.5 px-3 pt-2 pb-0.5 text-[10px] text-muted">
                <UserRound size={11} />
                <span className="min-w-0 flex-1 truncate" title={owner}>
                  {owner}
                </span>
              </div>
            )}
            {owned.map((account) => (
              <AccountRow
                key={account.id}
                cloud={cloud}
                account={account}
                active={account.id === selectedId}
              />
            ))}
          </div>
        ))}
        {shown.length === 0 && <p className="px-3 py-2 text-muted">{t("cloud.noMatch")}</p>}
      </div>
      <div className="border-t border-line px-3 py-1.5 text-[10px] text-muted">
        {cloud.version ?? cloud.command}
      </div>
    </aside>
  );
}

/** One account in the rail: name, second line, and the dot that says how it is doing. */
function AccountRow({
  cloud,
  account,
  active,
}: {
  cloud: CloudStatus;
  account: CloudAccount;
  active: boolean;
}) {
  const t = useT();
  const selectAccount = useCloud((s) => s.selectAccount);
  const setDefaultAccount = useCloud((s) => s.setDefaultAccount);
  const state = useCloud((s) => s.resources[slotOf(cloud.id, account.id)]);

  return (
    <div className={`group flex items-center pr-2 ${active ? "bg-elevated" : "hover:bg-elevated/60"}`}>
      <button
        onClick={() => void selectAccount(cloud.id, account.id)}
        className="flex min-w-0 flex-1 flex-col gap-px py-1.5 pl-3 text-left"
      >
        <span className="flex w-full items-center gap-1.5">
          <StateDot state={state} />
          <span className={`min-w-0 flex-1 truncate ${active ? "font-semibold text-fg" : ""}`}>
            {account.label}
          </span>
          {account.current && (
            <span title={t("cloud.cliDefault")} className="flex shrink-0">
              <Check size={11} className="text-ok" />
            </span>
          )}
        </span>
        {account.detail !== "" && (
          <span className="truncate pl-3.5 text-[10px] text-muted">{account.detail}</span>
        )}
      </button>
      {HAS_CLI_DEFAULT.has(cloud.id) && !account.current && (
        <button
          onClick={() => void setDefaultAccount(cloud.id, account)}
          title={t("cloud.makeDefault")}
          className="shrink-0 rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-fg"
        >
          <Star size={11} />
        </button>
      )}
    </div>
  );
}

/** Loaded, loading, failed or not yet asked - one dot, four states. */
function StateDot({ state }: { state: ResourceState | undefined }) {
  if (state?.kind === "loading") return <Loader2 size={9} className="shrink-0 animate-spin text-muted" />;
  const tone = state === undefined ? "bg-line" : state.kind === "loaded" ? "bg-ok" : "bg-danger";
  return <span className={`size-2 shrink-0 rounded-full ${tone}`} />;
}

/**
 * Accounts under whoever owns them, owners in the order they first appear: the
 * signed-in user for Azure, the Google account for Google Cloud. A cloud with
 * no owner level - AWS - comes back as one nameless group.
 */
function byOwner(accounts: CloudAccount[]): [string, CloudAccount[]][] {
  const owners = new Map<string, CloudAccount[]>();
  for (const account of accounts) {
    const bucket = owners.get(account.owner);
    if (bucket === undefined) owners.set(account.owner, [account]);
    else bucket.push(account);
  }
  return [...owners.entries()];
}

/** The selected account: its header, then whatever state its listing is in. */
function AccountPane({ cloud, account }: { cloud: CloudStatus; account: CloudAccount }) {
  const t = useT();
  const slot = slotOf(cloud.id, account.id);
  const state = useCloud((s) => s.resources[slot]);
  const reload = useCloud((s) => s.reload);
  const [filter, setFilter] = useState("");
  const deployOpen = useDeploy((s) => s.open === slot);

  // A deploy in progress or waiting to be confirmed stands in for the
  // resources it is about; Back brings them forward again without ending it.
  if (deployOpen) return <DeployPane slot={slot} />;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <Layers size={16} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 truncate text-[14px] font-semibold">{account.label}</h2>
            {account.current && (
              <span className="shrink-0 rounded-full bg-ok/15 px-2 py-px text-[10px] text-ok">
                {t("cloud.cliDefault")}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 text-[11px] text-muted">
            {account.detail !== "" && <span>{account.detail}</span>}
            {account.owner !== "" && <span>{account.owner}</span>}
            {state?.kind === "loaded" && <Facts state={state} />}
          </div>
        </div>
        {state?.kind === "loaded" && (
          <>
            {DEPLOYABLE.has(cloud.id) && <DeployButton cloud={cloud} account={account} slot={slot} />}
            <DiscoverButton cloud={cloud} />
            <button
              onClick={() => void reload(cloud.id, account.id)}
              title={t("cloud.reload")}
              className="flex shrink-0 items-center gap-1.5 rounded border border-line px-2 py-1 text-muted hover:border-accent hover:text-fg"
            >
              <RefreshCw size={11} /> {t("cloud.reloadShort")}
            </button>
          </>
        )}
      </header>
      <DiscoverResult cloud={cloud} />

      {state === undefined || state.kind === "loading" ? (
        <EmptyState
          icon={Loader2}
          spin
          title={t("cloud.loadingResources")}
          detail={listingCommand(cloud.id, account.id)}
        />
      ) : state.kind === "failed" ? (
        <FailedListing cloud={cloud} account={account} reason={state.reason} />
      ) : state.resources.length === 0 ? (
        <EmptyState icon={CloudIcon} title={t("cloud.empty")} />
      ) : (
        <LoadedAccount cloud={cloud} slot={slot} state={state} filter={filter} onFilter={setFilter} />
      )}
    </div>
  );
}

/**
 * Deploy the open project to this account: the AI plans, the person confirms
 * on the page that follows, Aime runs and proves (`stores/deploy.ts`). A deploy
 * already in hand for this account is shown again rather than started twice.
 */
function DeployButton({ cloud, account, slot }: { cloud: CloudStatus; account: CloudAccount; slot: string }) {
  const t = useT();
  const start = useDeploy((s) => s.start);
  const show = useDeploy((s) => s.show);
  const inHand = useDeploy((s) => s.slots[slot]);
  const hasProject = useWorkspace((s) => s.rootPath !== null);
  const busy = inHand !== undefined && inHand.stage.kind !== "done" && inHand.stage.kind !== "blocked";
  return (
    <button
      onClick={() => {
        if (inHand !== undefined) show(slot);
        else void start(cloud.id, account);
      }}
      disabled={!hasProject}
      title={hasProject ? t("deploy.buttonTitle") : t("deploy.needsProject")}
      className="flex shrink-0 items-center gap-1.5 rounded border border-accent/60 px-2 py-1 text-accent hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? <Loader2 size={11} className="animate-spin" /> : <Rocket size={11} />}
      {t("deploy.button")}
    </button>
  );
}

/**
 * The radar: asks the AI what is running here and writes it into the project's
 * AGENTS.md, so the next deployment or bug hunt starts from what exists. Needs
 * a project open, because that is where the note goes.
 */
function DiscoverButton({ cloud }: { cloud: CloudStatus }) {
  const t = useT();
  const discover = useCloud((s) => s.discover);
  const discovering = useCloud((s) => s.discovering);
  const hasProject = useWorkspace((s) => s.rootPath !== null);
  const busy = discovering === cloud.id;
  return (
    <button
      onClick={() => void discover(cloud.id)}
      disabled={!hasProject || discovering !== null}
      title={hasProject ? t("cloud.discover") : t("cloud.needsProject")}
      className="flex shrink-0 items-center gap-1.5 rounded border border-line px-2 py-1 text-muted hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? <Loader2 size={11} className="animate-spin" /> : <Radar size={11} />}
      {t("cloud.discoverShort")}
    </button>
  );
}

/** What the last discovery wrote, or why it wrote nothing - for this cloud. */
function DiscoverResult({ cloud }: { cloud: CloudStatus }) {
  const result = useCloud((s) => s.result);
  if (result === null || result.cloud !== cloud.label) return null;
  return (
    <div className="border-b border-line px-4 py-1.5">
      <Note icon={result.wrote ? Check : TriangleAlert} tone={result.wrote ? "muted" : "danger"}>
        {result.detail}
      </Note>
    </div>
  );
}

/** What is being run to list the account, so a wait is never a mystery. */
function listingCommand(cloudId: string, accountId: string): string {
  switch (cloudId) {
    case "aws":
      return `aws resourcegroupstaggingapi get-resources --profile ${accountId}`;
    case "gcp":
      return `gcloud asset search-all-resources --scope projects/${accountId}`;
    case "supabase":
      return `supabase functions list --project-ref ${accountId}`;
    default:
      return `az resource list --subscription ${accountId}`;
  }
}

/** The size of what was read, and when. */
function Facts({ state }: { state: Extract<ResourceState, { kind: "loaded" }> }) {
  const t = useT();
  const kinds = new Set(state.resources.map((resource) => resource.kind)).size;
  const regions = new Set(
    state.resources.map((resource) => resource.location).filter((region) => region !== ""),
  ).size;
  return (
    <>
      <span className="tabular-nums">{t("cloud.resourceCount", { count: state.resources.length })}</span>
      <span className="tabular-nums">{t("cloud.kindCount", { count: kinds })}</span>
      {regions > 0 && <span className="tabular-nums">{t("cloud.regionCount", { count: regions })}</span>}
      {state.truncated && (
        <span className="flex items-center gap-1 text-warn">
          <TriangleAlert size={11} /> {t("cloud.capped", { count: state.resources.length })}
        </span>
      )}
    </>
  );
}

/**
 * A listing the CLI refused, with its own words and the two things that fix it.
 *
 * Measured: `az account list` answers from cache while `az resource list` fails
 * with `Status_InteractionRequired`, so an account that looks signed in can
 * still need a sign-in - which an empty table would never say.
 */
function FailedListing({
  cloud,
  account,
  reason,
}: {
  cloud: CloudStatus;
  account: CloudAccount;
  reason: string;
}) {
  const t = useT();
  const reload = useCloud((s) => s.reload);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">
      <TriangleAlert size={28} className="text-danger" />
      <p className="font-medium">{t("cloud.resourcesFailed")}</p>
      <pre className="max-h-40 w-full max-w-2xl overflow-auto rounded-md border border-danger/40 bg-danger/10 p-3 text-[11px] whitespace-pre-wrap text-muted">
        {reason}
      </pre>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <SignInButton cloud={cloud} account={account} />
        <button
          onClick={() => void reload(cloud.id, account.id)}
          className="flex items-center gap-1.5 rounded border border-line px-3 py-1.5 hover:border-accent"
        >
          <RefreshCw size={11} /> {t("cloud.tryAgain")}
        </button>
      </div>
      <SignInProgress cloudId={cloud.id} />
    </div>
  );
}

/**
 * Signs into one account, the way that account needs.
 *
 * Azure and Google Cloud go through the browser-free flows (`cloud/sign_in.rs`):
 * the CLI prints its page instead of opening it, Aime opens the page from its
 * own process so the browser lands in FRONT of the editor, and the code travels
 * the way that CLI needs - Azure's is typed into the page, Google's is shown by
 * the page and pasted back. AWS runs the command the profile's own config calls
 * for in a terminal tab, where keys are typed in a real shell Aime never reads.
 */
function SignInButton({ cloud, account }: { cloud: CloudStatus; account: CloudAccount }) {
  const t = useT();
  const signIn = useCloud((s) => s.signIn);
  const progress = useCloud((s) => s.signIns[cloud.id]);
  const busy = progress?.stage === "starting" || progress?.stage === "code";
  return (
    <button
      onClick={() => void signIn(cloud.id, account)}
      disabled={busy}
      title={account.signIn}
      className="flex items-center gap-1.5 rounded bg-accent-strong px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-60"
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <LogIn size={12} />}
      {t("cloud.signInRun", { command: commandLabel(account.signIn) })}
    </button>
  );
}

/**
 * Where a browser-free sign-in stands: the code to type or the box to paste
 * one into, then the outcome.
 */
function SignInProgress({ cloudId }: { cloudId: string }) {
  const t = useT();
  const progress = useCloud((s) => s.signIns[cloudId]);
  const cancel = useCloud((s) => s.cancelSignIn);
  if (progress === undefined) return null;

  if (progress.stage === "starting")
    return (
      <Note icon={Loader2} spin>
        {t("cloud.signInStarting")}
      </Note>
    );

  if (progress.stage === "terminal")
    return (
      <Note icon={Loader2} spin>
        {t("cloud.signInTerminalWaiting")}
      </Note>
    );

  if (progress.stage === "exchanging")
    return (
      <Note icon={Loader2} spin>
        {t("cloud.signInExchanging")}
      </Note>
    );

  if (progress.stage === "page") {
    return (
      <div className="flex w-full max-w-2xl flex-col gap-2 rounded-lg border border-accent/40 bg-accent/5 p-3">
        <p className="font-medium">{t("cloud.signInPageTitle")}</p>
        {/* The code is shown by the page, not sent back to this machine, so the
            page can be opened anywhere - a phone, another computer - which is
            the way through a browser that a policy keeps from Google sign-in. */}
        <p className="text-[11px] text-muted">{t("cloud.signInPageElsewhere")}</p>
        <VerificationCodeForm cloudId={cloudId} rejected={progress.rejected} />
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <button
            onClick={() => {
              openUrl(progress.url).catch(console.error);
            }}
            className="flex items-center gap-1 text-accent hover:underline"
          >
            <ExternalLink size={11} /> {t("cloud.signInPageAgain")}
          </button>
          <span className="text-muted">·</span>
          <CopyLink url={progress.url} label={t("cloud.signInCopyLink")} />
          <span className="text-muted">·</span>
          <button onClick={() => void cancel(cloudId)} className="text-muted hover:text-fg hover:underline">
            {t("cloud.signInCancel")}
          </button>
        </div>
      </div>
    );
  }

  if (progress.stage === "code") {
    return (
      <div className="flex w-full max-w-2xl flex-col gap-2 rounded-lg border border-accent/40 bg-accent/5 p-3">
        <p className="font-medium">{t("cloud.signInCodeTitle")}</p>
        <div className="flex items-center gap-3">
          <code className="rounded-md border border-line bg-panel px-3 py-1.5 text-[18px] font-semibold tracking-[0.2em]">
            {progress.code}
          </code>
          <CopyButton text={progress.code} label={t("cloud.copy")} />
          <span className="text-muted">{t("cloud.signInCodeCopied")}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <button
            onClick={() => {
              openUrl(progress.url).catch(console.error);
            }}
            className="flex items-center gap-1 text-accent hover:underline"
          >
            <ExternalLink size={11} /> {t("cloud.signInOpenAgain", { url: progress.url })}
          </button>
          <span className="text-muted">·</span>
          <button onClick={() => void cancel(cloudId)} className="text-muted hover:text-fg hover:underline">
            {t("cloud.signInCancel")}
          </button>
        </div>
      </div>
    );
  }

  return progress.ok ? (
    <Note icon={Check}>{t("cloud.signInDone")}</Note>
  ) : (
    <Note icon={TriangleAlert} tone="danger">
      {progress.message === "" ? t("cloud.signInFailed") : progress.message}
    </Note>
  );
}

/** The sign-in page's address, one click to the clipboard, for another device. */
function CopyLink({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(url).then(() => {
          setCopied(true);
          setTimeout(() => {
            setCopied(false);
          }, 1500);
        });
      }}
      className="flex items-center gap-1 text-accent hover:underline"
    >
      {copied ? <Check size={11} className="text-ok" /> : <Copy size={11} />} {label}
    </button>
  );
}

/**
 * The box a Google verification code is pasted into.
 *
 * The code goes to the CLI's stdin and nowhere else (`cloud_sign_in_code`); a
 * paste the Rust side refused for its shape is said so here, beside the box,
 * with the box left as it was so the person can see what they pasted.
 */
function VerificationCodeForm({ cloudId, rejected }: { cloudId: string; rejected: string | undefined }) {
  const t = useT();
  const submit = useCloud((s) => s.submitSignInCode);
  const [code, setCode] = useState("");
  const ready = code.trim() !== "";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void submit(cloudId, code);
      }}
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-center gap-2">
        <input
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
          }}
          placeholder={t("cloud.signInPagePlaceholder")}
          autoFocus
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-line bg-panel px-3 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={!ready}
          className="flex shrink-0 items-center gap-1.5 rounded bg-accent-strong px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-60"
        >
          <LogIn size={12} /> {t("cloud.signInPageSubmit")}
        </button>
      </div>
      {rejected !== undefined && <span className="text-[11px] text-danger">{rejected}</span>}
    </form>
  );
}

/** A loaded account: the toolbar, then the map or the list. */
function LoadedAccount({
  cloud,
  slot,
  state,
  filter,
  onFilter,
}: {
  cloud: CloudStatus;
  slot: string;
  state: Extract<ResourceState, { kind: "loaded" }>;
  filter: string;
  onFilter: (text: string) => void;
}) {
  const t = useT();
  const view = useCloud((s) => s.view[slot] ?? "map");
  const setView = useCloud((s) => s.setView);
  const basis = useCloud((s) => s.basis[slot]);
  const setBasis = useCloud((s) => s.setBasis);
  const openDetail = useCloud((s) => s.openDetail);
  const [grouping, setGrouping] = useState<Grouping>("kind");
  /**
   * Collapse-all and expand-all as a value the groups react to rather than a
   * command down the tree: the stamp changes on every click, so a second
   * collapse-all after somebody unfolded one group still reaches all of them.
   */
  const [foldAll, setFoldAll] = useState(0);
  const [foldedAll, setFoldedAll] = useState(true);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") return state.resources;
    // The short kind is searched too: a chip puts `compute/Instance` in the box,
    // and that is not a substring of `compute.googleapis.com/Instance`.
    return state.resources.filter((resource) =>
      `${resource.name} ${resource.kind} ${shortKind(resource.kind)} ${resource.group} ${resource.location} ${Object.values(resource.tags).join(" ")}`
        .toLowerCase()
        .includes(needle),
    );
  }, [state.resources, filter]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        <ViewSwitch
          view={view}
          onView={(next) => {
            setView(slot, next);
          }}
        />
        <label className="flex min-w-48 flex-1 items-center gap-1.5 rounded border border-line bg-panel px-2 py-1">
          <Search size={11} className="shrink-0 text-muted" />
          <input
            value={filter}
            onChange={(event) => {
              onFilter(event.target.value);
            }}
            placeholder={t("cloud.filter", { count: state.resources.length })}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
          />
          {filter !== "" && (
            <button
              onClick={() => {
                onFilter("");
              }}
              className="text-muted hover:text-fg"
            >
              <X size={11} />
            </button>
          )}
        </label>
        {view === "list" && (
          <>
            <button
              onClick={() => {
                setGrouping(GROUPINGS[(GROUPINGS.indexOf(grouping) + 1) % GROUPINGS.length] ?? "kind");
              }}
              title={t("cloud.groupBy", { by: t(GROUPING_LABELS[grouping]) })}
              className="flex shrink-0 items-center gap-1 rounded border border-line px-2 py-1 text-muted hover:border-accent hover:text-fg"
            >
              {createElement(iconOfGrouping(grouping), { size: 11 })}
              {t(GROUPING_LABELS[grouping])}
            </button>
            <button
              onClick={() => {
                setFoldAll(Date.now());
                setFoldedAll(true);
              }}
              title={t("cloud.collapseAll")}
              className="shrink-0 rounded p-1 text-muted hover:bg-elevated hover:text-fg"
            >
              <ChevronsDownUp size={13} />
            </button>
            <button
              onClick={() => {
                setFoldAll(Date.now());
                setFoldedAll(false);
              }}
              title={t("cloud.expandAll")}
              className="shrink-0 rounded p-1 text-muted hover:bg-elevated hover:text-fg"
            >
              <ChevronsUpDown size={13} />
            </button>
          </>
        )}
        {filter !== "" && (
          <span className="shrink-0 text-muted">{t("cloud.matching", { count: shown.length })}</span>
        )}
      </div>

      {shown.length === 0 ? (
        <EmptyState icon={Search} title={t("cloud.noMatch")} />
      ) : view === "map" ? (
        <CloudMap
          resources={shown}
          basis={basis}
          onBasis={(next) => {
            setBasis(slot, next);
          }}
          onOpen={openDetail}
        />
      ) : (
        <ResourceList
          cloudId={cloud.id}
          resources={shown}
          grouping={grouping}
          foldAll={foldAll}
          foldedAll={foldedAll}
          onOpen={openDetail}
          onFilter={onFilter}
        />
      )}
    </>
  );
}

/** Map or list, as a segmented control. */
function ViewSwitch({ view, onView }: { view: CloudViewMode; onView: (view: CloudViewMode) => void }) {
  const t = useT();
  const segment = (mode: CloudViewMode, icon: LucideIcon, label: string) => (
    <button
      onClick={() => {
        onView(mode);
      }}
      className={`flex items-center gap-1.5 px-2.5 py-1 ${
        view === mode ? "bg-elevated font-medium text-fg" : "text-muted hover:text-fg"
      }`}
    >
      {createElement(icon, { size: 12 })}
      {label}
    </button>
  );
  return (
    <div className="flex shrink-0 overflow-hidden rounded border border-line bg-panel">
      {segment("map", Network, t("cloud.viewMap"))}
      {segment("list", ListTree, t("cloud.viewList"))}
    </div>
  );
}

/** What each grouping is called, for the one control that switches them. */
const GROUPING_LABELS: Record<Grouping, TranslationKey> = {
  kind: "cloud.groupKind",
  group: "cloud.groupGroup",
  location: "cloud.groupLocation",
};

/**
 * Rows drawn per group before the rest is folded behind a count.
 *
 * The same rule the branch menu uses (`ContextMenu.tsx`): a group of 3,730
 * snapshots is not read by scrolling, it is read by typing, and the filter
 * box searches everything whether or not it is drawn.
 */
const ROWS_PER_GROUP = 200;

/**
 * Every resource, under headings, each heading foldable.
 *
 * Groups start folded so an account of six thousand resources opens as forty
 * headings with counts - the shape of the account - rather than as a wall; the
 * chips above the list narrow it to one kind in a click.
 */
function ResourceList({
  cloudId,
  resources,
  grouping,
  foldAll,
  foldedAll,
  onOpen,
  onFilter,
}: {
  cloudId: string;
  resources: CloudResource[];
  grouping: Grouping;
  foldAll: number;
  foldedAll: boolean;
  onOpen: (resource: CloudResource) => void;
  onFilter: (text: string) => void;
}) {
  const t = useT();
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  // Every group takes the last collapse-all/expand-all as its default, and a
  // group folded by hand since then keeps its own answer.
  const [stamp, setStamp] = useState(foldAll);
  if (stamp !== foldAll) {
    setStamp(foldAll);
    setFolded({});
  }
  const groups = useMemo(() => groupResources(resources, grouping), [resources, grouping]);
  const kinds = useMemo(() => summarize(resources), [resources]);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
        {kinds.map(([kind, count]) => (
          <button
            key={kind}
            onClick={() => {
              onFilter(shortKind(kind));
            }}
            title={kind}
            className="rounded-md hover:ring-1 hover:ring-accent"
          >
            <KindChip kind={kind} count={count} />
          </button>
        ))}
      </div>

      <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_10rem_10rem_7rem] gap-3 border-b border-line bg-bg px-3 py-1 text-[10px] tracking-wide text-muted uppercase">
        <span>{t("cloud.field.name")}</span>
        <span>{t("cloud.field.kind")}</span>
        <span>{t(GROUP_LABELS[cloudId] ?? "cloud.field.group")}</span>
        <span>{t("cloud.field.location")}</span>
      </div>

      {groups.map(([heading, owned]) => {
        const shut = folded[heading] ?? foldedAll;
        const drawn = owned.slice(0, ROWS_PER_GROUP);
        return (
          <div key={heading}>
            <button
              onClick={() => {
                setFolded((current) => ({ ...current, [heading]: !shut }));
              }}
              className="flex w-full items-center gap-1.5 border-b border-line bg-panel px-3 py-1.5 text-left hover:bg-elevated"
            >
              {shut ? (
                <ChevronRight size={12} className="text-muted" />
              ) : (
                <ChevronDown size={12} className="text-muted" />
              )}
              {grouping === "kind" ? (
                <ServiceBadge kind={heading} />
              ) : (
                createElement(iconOfGrouping(grouping), { size: 12, className: "text-muted" })
              )}
              <span className="min-w-0 flex-1 truncate font-medium" title={heading}>
                {grouping === "kind" ? shortKind(heading) : heading}
              </span>
              <span className="shrink-0 tabular-nums text-muted">{owned.length}</span>
            </button>
            {!shut &&
              drawn.map((resource) => (
                <button
                  key={resource.id}
                  onClick={() => {
                    onOpen(resource);
                  }}
                  className="grid w-full grid-cols-[minmax(0,1fr)_10rem_10rem_7rem] items-center gap-3 border-b border-line/60 px-3 py-1 text-left hover:bg-elevated"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <ServiceBadge kind={resource.kind} />
                    <span className="truncate">{resource.name}</span>
                  </span>
                  <span className="truncate text-muted" title={resource.kind}>
                    {shortKind(resource.kind)}
                  </span>
                  <span className="truncate text-muted">{resource.group}</span>
                  <span className="flex items-center gap-1 truncate text-muted">
                    {resource.location !== "" && <MapPin size={10} className="shrink-0" />}
                    {resource.location}
                  </span>
                </button>
              ))}
            {!shut && owned.length > drawn.length && (
              <p className="border-b border-line/60 px-3 py-1 pl-9 text-[11px] text-muted">
                {t("cloud.andMoreFilter", { count: owned.length - drawn.length })}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** How many kinds the chip strip shows before it gets busy. */
const SUMMARY_CHIPS = 12;

/** The kinds in this account and how many of each, biggest first, capped. */
function summarize(resources: CloudResource[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const resource of resources) counts.set(resource.kind, (counts.get(resource.kind) ?? 0) + 1);
  return [...counts.entries()].sort(([, left], [, right]) => right - left).slice(0, SUMMARY_CHIPS);
}

/**
 * Divides the list into headings, biggest group first: the order that answers
 * "what is this account mostly made of" without scrolling.
 */
function groupResources(resources: CloudResource[], grouping: Grouping): [string, CloudResource[]][] {
  const groups = new Map<string, CloudResource[]>();
  for (const resource of resources) {
    const key =
      (grouping === "kind" ? resource.kind : grouping === "group" ? resource.group : resource.location) ||
      "—";
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [resource]);
    else bucket.push(resource);
  }
  return [...groups.entries()].sort(
    ([leftKey, left], [rightKey, right]) => right.length - left.length || leftKey.localeCompare(rightKey),
  );
}

/**
 * A cloud with no accounts, drawn as a state rather than left blank.
 *
 * Three different facts land here and each has its own next move: the CLI is
 * not on this machine, it is here but nobody has signed in, or Aime has no
 * measured way to ask this particular CLI for its accounts.
 */
function NoAccounts({ cloud }: { cloud: CloudStatus }) {
  const setInstallerTools = useLayout((s) => s.setInstallerTools);
  const signIn = useCloud((s) => s.signIn);
  const probing = useCloud((s) => s.probing);
  const t = useT();

  // While the CLIs are being asked again, the last answer is not the answer.
  if (!cloud.installed && probing) return <EmptyState icon={Loader2} spin title={t("cloud.looking")} />;

  if (!cloud.installed) {
    return (
      <EmptyState icon={Download} title={t("cloud.notInstalled")}>
        {cloud.installable ? (
          <button
            onClick={() => {
              setInstallerTools([cloud.id]);
            }}
            className="flex items-center gap-1.5 rounded bg-accent-strong px-3 py-1.5 font-medium text-white hover:opacity-90"
          >
            <Download size={12} /> {t("cloud.install")}
          </button>
        ) : (
          <CopyCommand command={cloud.installHint} label={t("cloud.copy")} />
        )}
      </EmptyState>
    );
  }

  // No account is known yet, so the sign-in is the cloud's generic one.
  const fresh: CloudAccount = {
    id: "",
    label: "",
    detail: "",
    current: false,
    owner: "",
    tenant: "",
    signIn: cloud.signInHint,
  };
  return (
    <EmptyState icon={LogIn} title={t("cloud.signInFirst")}>
      <button
        onClick={() => void signIn(cloud.id, fresh)}
        title={cloud.signInHint}
        className="flex items-center gap-1.5 rounded bg-accent-strong px-3 py-1.5 font-medium text-white hover:opacity-90"
      >
        <LogIn size={12} /> {t("cloud.signInRun", { command: commandLabel(cloud.signInHint) })}
      </button>
      <SignInProgress cloudId={cloud.id} />
    </EmptyState>
  );
}

/** A command the user runs themselves, one click to the clipboard. */
function CopyCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => {
            setCopied(false);
          }, 1500);
        });
      }}
      title={label}
      className="flex items-center gap-1.5 rounded border border-line px-2 py-1 text-left hover:border-accent"
    >
      {copied ? <Check size={11} className="shrink-0 text-ok" /> : <Copy size={11} className="shrink-0" />}
      <code className="break-all">{command}</code>
    </button>
  );
}

/**
 * A state with nothing to list, drawn as a state: a large icon, one sentence,
 * and the action that changes it. A blank pane reads as a broken app.
 */
function EmptyState({
  icon,
  title,
  detail,
  spin = false,
  children,
}: {
  icon: LucideIcon;
  title: string;
  detail?: string;
  spin?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      {createElement(icon, { size: 32, className: `text-muted opacity-60 ${spin ? "animate-spin" : ""}` })}
      <p className="max-w-md text-[13px] text-muted">{title}</p>
      {detail !== undefined && <code className="text-[11px] text-muted opacity-70">{detail}</code>}
      {children}
    </div>
  );
}
