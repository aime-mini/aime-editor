/**
 * What the cloud prompts have to know about the CLI behind a cloud.
 *
 * The mirror of `cloud/dialect.rs`, which is where the same differences are
 * ENFORCED: this file only tells the AI what the checker will hold it to, so a
 * rule written here and not there is a rule nothing applies, and a rule there
 * and not here is a refusal the AI could not have seen coming.
 *
 * Two tiers, because they are two different claims. A cloud with a
 * `CliDialect` is one whose command line Aime has measured, so it can prove a
 * single command and offer the operations on a resource. A cloud that also has
 * a `DeployRecipe` is one Aime can plan a whole deployment for, which is a
 * much larger claim - it needs the prompt to carry that cloud's own idea of a
 * plan, and it is only made once a real deployment has run end to end. AWS has
 * the first and not the second (2026-09-18): the panel works on what is
 * already there, and shows no Deploy button.
 */

/** One cloud's command line, as a prompt has to describe it. */
export interface CliDialect {
  /** The cloud as a person reads it. */
  cloud: string;
  /** The CLI every command runs as, unless a step names the second one. */
  program: string;
  /** The flag naming the account, which Aime pins on every command it runs. */
  scopeUnit: string;
  /** The flag naming who owns it, for a CLI that takes one. */
  scopeOwner?: string;
  /** How this CLI is asked for JSON. */
  jsonFlags: [string, string];
  /** The rule for a single operation on one resource. */
  opsKeepRule: string;
  /** The flags Aime adds itself, as the operations prompt lists them. */
  ownFlags: string;
  /** The command groups an operation may not enter, as that prompt lists them. */
  refusedGroups: string;
  /** What this cloud calls the group a resource lives in. */
  groupWord: string;
  /**
   * Flags Aime puts on the command line that the confirm page cannot show.
   *
   * The page says it will run exactly what it shows, so where that is not the
   * whole truth it has to say what else goes on. Only Supabase has any: the
   * work folder is this installation's own path, which the page has no way to
   * know (`cloud/dialect.rs`, `runtime_flags`).
   */
  alsoAdds?: string;
  /**
   * Rules that belong to this CLI alone, added to the operations prompt.
   *
   * Every one of them is enforced in `cloud/dialect.rs`; they live here so the
   * AI is not refused for something it was never told.
   */
  opsNotes: string[];
}

/** What planning a whole deployment needs on top of the command line. */
export interface DeployRecipe {
  /** What that CLI calls the thing a deployment happens inside. */
  target: string;
  /** The label for that thing on the confirm page, as a translation key. */
  scopeLabel: "deploy.project" | "deploy.subscription";
  /** The rules of the command line, as the Rust checker enforces them. */
  rules: string;
  /** What keeps a running service's settings, in this CLI's own terms. */
  keepRule: string;
  /** A `resourceId` as this cloud writes one, for the survey's example. */
  resourceId: string;
  /** A read of an existing service, for the survey's example. */
  inspect: string;
  /** The `keep`, `steps` and `prove` of a plan, in this cloud's own commands. */
  keep: string;
  steps: string;
  prove: string;
  /** The region a plan's example names, which is the one both clouds serve here. */
  region: string;
  /**
   * The address Aime builds a proof request from, when this cloud has no read
   * that answers one.
   *
   * `<account>` is the account the deployment ran against. Supabase needs it:
   * an Edge Function's URL follows from the project ref and appears in no
   * listing, and a URL taken from a plan would be a request Aime makes to
   * wherever an answer pointed.
   */
  endpoint?: string;
}

/** A cloud's command line, and the deployment recipe where there is one. */
export type CloudDialect = CliDialect & { deploy?: DeployRecipe };

const GCLOUD_RULES = [
  // Measured 2026-09-12: given a repository that is plainly Kubernetes - a
  // Dockerfile, a 2-replica Deployment, a LoadBalancer Service and a README
  // saying `kubectl apply` - the AI proposed Cloud Run and said what it had
  // substituted and why. Good judgement, but it was guessing at Aime's limits:
  // nothing here said which programs a step may run. A step may now say
  // `kubectl`, and the two programs are named rather than left to be inferred.
  "- A step runs as `gcloud` unless it sets `program` to `kubectl`, and those are the only two. Never " +
    "`helm`, `terraform`, `docker`, a shell or a script: a shape that needs one of those cannot be " +
    "deployed from here, so choose what these two can deploy and say plainly in `architecture` what you " +
    "substituted for what, and what is given up.",
  "- `kubectl` is for putting a workload on a GKE cluster and watching it come up: `apply`, `create`, " +
    "`expose`, `scale`, `set`, `rollout`, `annotate`, `label`, `patch`, `wait`, `get`. A READ may name it " +
    "too - `get`, `describe`, `logs`, `top`, `explain`, `cluster-info`, `api-resources`, `version` - and " +
    "that is how you look at a cluster when a step fails. It needs an earlier " +
    "`gcloud container clusters get-credentials` step to point it at the cluster; it takes NO `--project` " +
    "or `--account` (Aime adds those to `gcloud` only, and `kubectl` refuses them); write every flag in " +
    "its long form as two tokens (`--filename`, `k8s/deployment.yaml`). Aime installs " +
    "`gke-gcloud-auth-plugin` itself when it is missing, so do not plan that.",
  "- `args` are the arguments after `gcloud`, one token each, in the order the CLI takes them: command " +
    "words, then positionals, then flags. A flag and its value are two tokens (`--region`, `asia-southeast1`), " +
    "never `--region=…`.",
  "- Aime itself adds `--project` and `--account` to every command and `--format json` to every read - " +
    "never include them, and never `--quiet`: prompts are already disabled, so anything the CLI would have " +
    "asked (enable an API, allow unauthenticated access) must be an explicit step or flag. A command or read " +
    "that needs a location names it itself (`--region`, `asia-southeast1`).",
  "- A deployment adds and updates. Never `delete`, `destroy`, `purge`, `undelete` or a `remove-*` command; " +
    "never the `projects`, `billing`, `organizations`, `auth`, `config` or `components` groups - with one " +
    "exception: `projects add-iam-policy-binding` IS allowed, because a source build needs its service " +
    "account to have the roles for it. Its `--member` must be a `serviceAccount:` (never a person, a group " +
    "or `allUsers`) and its `--role` must be the narrow role that job needs - `roles/owner`, `roles/editor` " +
    "and the IAM-admin roles are refused.",
  "- Values hold letters, digits and `_.:/=,*@+-` only - no spaces, no quotes, nothing a shell could misread.",
].join("\n");

const AZ_RULES = [
  "- A step runs as `az` and nothing else. Never `kubectl`, `helm`, `terraform`, `docker`, `func`, a shell " +
    "or a script: a shape that needs one of those cannot be deployed from here, so choose what `az` alone " +
    "can deploy and say plainly in `architecture` what you substituted for what, and what is given up.",
  "- `args` are the arguments after `az`, one token each, in the order the CLI takes them: command words, " +
    "then positionals, then flags. A flag and its value are two tokens (`--location`, `southeastasia`), " +
    "never `--location=…`.",
  "- Aime itself adds `--subscription` to every command and `--output json` to every read - never include " +
    "them, and never `-o`. A command that needs a location or a resource group names them itself.",
  "- Every Azure resource lives in a RESOURCE GROUP. When this app has none, `group create` is the first step.",
  "- A resource provider must be registered before the subscription can hold its first resource, and that " +
    "is a step like any other: `provider register --namespace Microsoft.Web --wait`. Measured on a real " +
    "subscription: one that had never used Container Apps answered *Subscription … is not registered for " +
    "the Microsoft.App resource provider*.",
  "- Extensions are NOT installed for you: a command that lives in an `az` extension this machine does not " +
    "have is refused in the CLI's own words. Plan with the commands core `az` carries.",
  "- A deployment adds and updates. Never `delete`, `destroy`, `purge`, `undelete` or a `remove-*` command; " +
    "never the `account`, `login`, `logout`, `config`, `configure`, `extension`, `upgrade`, `ad`, `role`, " +
    "`billing`, `consumption`, `rest` or `interactive` groups. `rest` most of all: it is a raw API call, " +
    "which goes around every rule here.",
  "- Values hold letters, digits and `_.:/=,*@+-` only - no spaces, no quotes, nothing a shell could misread.",
].join("\n");

const SUPABASE_RULES = [
  "- A step runs as `supabase` and nothing else. Never `psql`, `docker`, `npm`, a shell or a script: a " +
    "shape that needs one of those cannot be deployed from here, so choose what this CLI alone can " +
    "deploy and say plainly in `architecture` what you substituted for what, and what is given up.",
  "- `args` are the arguments after `supabase`, one token each, in the order the CLI takes them: the " +
    "group, the command, then positionals, then flags. A flag and its value are two tokens.",
  "- The PROJECT ALREADY EXISTS - it is the account you are deploying to. Never `projects create`, " +
    "never `projects delete`, and never ask for a region: a Supabase project's region is fixed when it " +
    "is created.",
  "- Aime adds `--project-ref`, `-o json`, `--agent no`, `--experimental`, `--yes` and a `--workdir` " +
    "pointing at this repository - never include any of them.",
  // Measured on the first real deploy, 2026-09-21: the survey asked for
  // `projects list`, Aime pinned `--project-ref` onto it as it does onto
  // everything, and the CLI answered *Unrecognized flag: --project-ref in
  // command supabase projects list*.
  "- Because `--project-ref` goes onto every command, never plan one that does not take it. " +
    "`projects list` and `orgs list` are account-level and refuse it. What reads THIS project is " +
    "`functions list`, `secrets list`, `branches list`, `postgres-config get`, `ssl-enforcement get` " +
    "and `network-restrictions get`.",
  "- What this cloud deploys are the things a Supabase project is made of, and each one is a directory " +
    "in the repository: `supabase/functions/<slug>/index.ts` goes up with `functions deploy <slug>`, " +
    "`supabase/migrations/*.sql` with `db push`, and `supabase/config.toml` with `config push`. A " +
    "repository that has none of them needs those files written first - put them in `files`.",
  "- The repository has to be bound to the project before the database can be reached: `init` when " +
    "there is no `supabase/` directory yet, then `link`, and only then `db push`. Measured: every `db` " +
    "command refuses `--project-ref` unless the project is linked. `functions deploy` needs no link.",
  // Measured from the CLI's own help: `--use-api` is *Bundle functions
  // server-side without using Docker*. Aime promises nothing about Docker
  // being installed or running on the machine it is on, so a deploy that
  // needs it is a deploy that fails on somebody else's laptop.
  "- `functions deploy` bundles with Docker unless it is told otherwise, and Aime does not require " +
    "Docker on this machine: always pass `--use-api`, which bundles on the server.",
  "- An Edge Function answers at `https://<project-ref>.supabase.co/functions/v1/<slug>`, and by " +
    "default it demands an Authorization header and answers 401 without one. Aime proves a deployment " +
    "with a plain GET, so deploy anything meant to answer the open internet with `--no-verify-jwt`, and " +
    "write the function's own path in `prove.path` (`/hello`).",
  "- A deployment adds and updates. Never `delete`, `destroy`, `purge` or a `remove-*` command; never " +
    "`db reset`, `db query`, `start`, `stop`, `status` or `test` (the local Docker stack), and never " +
    "`login`, `logout`, `orgs`, `telemetry` or `gen`.",
  "- Values hold letters, digits and `_.:/=,*@+-` only - no spaces, no quotes, nothing a shell could misread.",
].join("\n");

const DIALECTS = {
  gcp: {
    cloud: "Google Cloud",
    program: "gcloud",
    scopeUnit: "--project",
    scopeOwner: "--account",
    jsonFlags: ["--format", "json"],
    opsNotes: [],
    opsKeepRule:
      "- To change a setting of something already running, use an `--update-*` flag; a `--set-*`, " +
      "`--clear-*` or `--remove-*` flag replaces or wipes what is there and will be refused.",
    ownFlags: "`--project`, `--account` and `--format`",
    refusedGroups: "`projects`, `billing`, `organizations`, `auth`, `config` or `components`",
    groupWord: "the project it lives in",
    deploy: {
      target: "project",
      scopeLabel: "deploy.project",
      rules: GCLOUD_RULES,
      keepRule:
        "- When a service for this app ALREADY EXISTS, its settings are kept: use `--update-env-vars`, " +
        "`--update-labels`, `--update-secrets` and the other `--update-*` flags, which merge. `--set-*`, " +
        "`--clear-*` and `--remove-*` replace or wipe what is there and Aime refuses them for an existing service.",
      region: "asia-southeast1",
      resourceId: "//run.googleapis.com/projects/p/locations/r/services/s",
      inspect:
        '{"purpose":"overview","label":"gcloud run services describe","args":["run","services","describe","s","--region","r"]}',
      keep:
        '{"label":"environment variables","read":{"purpose":"overview","label":"gcloud run services describe",' +
        '"args":["run","services","describe","web","--region","asia-southeast1"]},"path":"spec.template.spec.containers.0.env"}',
      steps:
        '{"label":"Enable the APIs","args":["services","enable","run.googleapis.com"],"changes":"the project\'s enabled APIs"},' +
        '{"label":"Apply the manifests","program":"kubectl","args":["apply","--filename","k8s/"],"changes":"the cluster\'s workloads"}',
      prove:
        '{"read":{"purpose":"overview","label":"gcloud run services describe","args":["run","services","describe","web",' +
        '"--region","asia-southeast1"]},"urlPath":"status.url","path":"/","expect":200}',
    },
  },
  azure: {
    cloud: "Azure",
    program: "az",
    // `az` has no account flag: the signed-in user sits in the token behind
    // the subscription id, and passing one would fail the command.
    scopeUnit: "--subscription",
    jsonFlags: ["--output", "json"],
    opsNotes: [],
    // Azure has no flag family that overwrites, so the rule is about naming
    // the thing being changed rather than about a prefix.
    opsKeepRule:
      "- To change a setting of something already running, use the command that names that setting " +
      "(`webapp config appsettings set`), never one that rewrites the whole resource from a template.",
    ownFlags: "`--subscription` and `--output`",
    refusedGroups:
      "`account`, `login`, `logout`, `config`, `configure`, `extension`, `upgrade`, `ad`, `role`, " +
      "`billing`, `consumption`, `rest` or `interactive`",
    groupWord: "its resource group, which nearly every `az` command needs",
    deploy: {
      target: "subscription",
      scopeLabel: "deploy.subscription",
      rules: AZ_RULES,
      // Azure has no flag family that means "replace what is there", so nothing
      // here is refused by shape (`cloud/dialect.rs` says the same). What keeps a
      // running service's settings is naming the thing being changed.
      keepRule:
        "- When a service for this app ALREADY EXISTS, change only what you mean to: `az webapp config " +
        "appsettings set` names the settings it sets, while redeploying the whole resource from a template " +
        "that omits what is there wipes it. Aime reads every setting the plan lists under `keep` before and " +
        "after the deployment and reports the ones that changed.",
      region: "southeastasia",
      resourceId: "/subscriptions/s/resourceGroups/g/providers/Microsoft.Web/sites/web",
      inspect:
        '{"purpose":"overview","label":"az webapp show","args":["webapp","show","--name","web","--resource-group","g"]}',
      keep:
        '{"label":"always on","read":{"purpose":"overview","label":"az webapp config show",' +
        '"args":["webapp","config","show","--name","web","--resource-group","rg-web"]},"path":"alwaysOn"}',
      steps:
        '{"label":"Create the resource group","args":["group","create","--name","rg-web","--location","southeastasia"],' +
        '"changes":"a new resource group"},' +
        '{"label":"Deploy the app","args":["webapp","up","--name","web","--resource-group","rg-web","--location",' +
        '"southeastasia","--sku","F1","--runtime","NODE:22-lts"],"changes":"the web app, its plan and its code"}',
      // `az webapp show` answers a bare host in `defaultHostName`, which the
      // prove step reads as `https://<host>` - the same shape App Engine has.
      prove:
        '{"read":{"purpose":"overview","label":"az webapp show","args":["webapp","show","--name","web",' +
        '"--resource-group","rg-web"]},"urlPath":"defaultHostName","path":"/","expect":200}',
    },
  },
  /**
   * AWS, measured 2026-09-18 against aws-cli 2.17.31 - the command line only.
   *
   * There is no `deploy` here on purpose. Aime can prove a single `aws`
   * command, so the panel offers the day-to-day work on a resource that
   * already exists; it has never planned and run a whole deployment on AWS, so
   * it does not offer to.
   */
  aws: {
    cloud: "AWS",
    program: "aws",
    // A profile IS the account on AWS: the credentials are what reach it, and
    // there is nothing above them to name.
    scopeUnit: "--profile",
    jsonFlags: ["--output", "json"],
    opsNotes: [
      // Measured in the app 2026-09-18: asked about a `logs/log-group`, the AI
      // answered `tail` and `delete-log-group` with no service word, as if the
      // `logs` in the resource type had already been said. Two of six
      // operations were lost to it, and the CLI would not have known either
      // command.
      "- An `aws` command line is always `<service> <operation>`, both words and in that order: " +
        "`logs tail`, `logs put-retention-policy`, `ecs update-service`. The service is never implied " +
        "by the resource type - `aws tail` is not a command the CLI has.",
      // Aime pins the profile but not the region: the region belongs to the
      // resource, which is why it is a placeholder rather than a flag Aime
      // adds. Without this line the AI writes commands that quietly run in
      // whatever region the profile defaults to.
      "- Every command that works on a regional resource must name it: write `--region` and `<region>`, " +
        "which Aime fills from the resource itself. Aime does NOT add this one.",
      "- Never `ssm start-session`, `ssm send-command`, `ssm start-automation-execution` or " +
        "`ecs execute-command`: those run code on a machine rather than asking a service for something. " +
        "The rest of `ssm` and `ecs` is exactly the work this list is for.",
    ],
    opsKeepRule:
      "- To change a setting of something already running, use the command that names that setting " +
      "(`ecs update-service --service`), never one that rewrites the whole resource from a template.",
    ownFlags: "`--profile` and `--output`",
    refusedGroups:
      "`configure`, `sso`, `iam`, `sts`, `organizations`, `account`, `budgets`, `ce` or " +
      "`ec2-instance-connect`",
    // An ARN carries the account number where the other two clouds carry a
    // group, and almost no command takes it - said plainly so the AI does not
    // reach for a resource group that AWS does not have.
    groupWord: "the AWS account number it belongs to, which few commands take",
  },
  /**
   * Supabase, measured 2026-09-18 on the CLI 2.116.0 - the command line only.
   *
   * No `deploy` here either, and for a reason worth stating: Aime runs this
   * CLI from a work folder of its own that holds no project, so the commands
   * that deploy anything (`db push`, `functions deploy`, `config push`) would
   * push emptiness. What works is everything that acts on the REMOTE project
   * through `--project-ref`, which is what the panel is for.
   */
  supabase: {
    cloud: "Supabase",
    program: "supabase",
    scopeUnit: "--project-ref",
    // `-o`, not `--output`: this CLI has both and they mean different things
    // (`--output-format` is a third). Aime pins the one the schemas describe.
    jsonFlags: ["-o", "json"],
    opsNotes: [
      "- A command is `<group> <command>`, both words, as `supabase --help` lists them: `functions list`, " +
        "`secrets set`, `branches update`, `postgres-config get`. Never a group on its own.",
      // The local-project trap, said plainly rather than left to a refusal.
      "- Aime runs this CLI from a work folder of its own that holds NO project and links none, so " +
        "anything reading a local `supabase/` directory has nothing to read. Only commands that act on " +
        "the remote project through `--project-ref` belong here; `config push` and `functions deploy` " +
        "are refused for that reason, and so is the local Docker stack (`start`, `stop`, `status`, " +
        "`test`).",
      // Measured 2026-09-21 against a real project: every `db` command answers
      // *--project-ref only applies when targeting the linked project*, and
      // `migration list`, `inspect db table-stats` and `storage ls` each ask
      // for a link or a key that only a link provides.
      "- The whole of `db`, `migration`, `inspect` and `storage` reaches the database itself, which " +
        "this CLI does only for a LINKED project - so none of those can run here, whatever they are " +
        "asked to do.",
    ],
    opsKeepRule:
      "- To change a setting of something already running, use the command that names that setting " +
      "(`secrets set`, `branches update`), never one that rewrites the project from a local file.",
    ownFlags: "`--project-ref`, `-o`, `--workdir`, `--agent`, `--experimental` and `--yes`",
    refusedGroups:
      "`login`, `logout`, `sso`, `link`, `unlink`, `orgs`, `telemetry`, `completion`, `init`, " +
      "`bootstrap`, `seed`, `gen`, `issue`, `start`, `stop`, `status`, `test`, `db`, `migration`, " +
      "`inspect` or `storage`",
    // Supabase resources are addressed by the project they live in, which is
    // the same thing `--project-ref` already pins - so there is nothing for a
    // command to name, and saying so stops the AI reaching for one.
    groupWord: "the project it lives in, which almost nothing needs because Aime already pins it",
    alsoAdds:
      "`--agent no --experimental --yes`, and a `--workdir` - Aime's own folder for work on a " +
      "resource, this repository for a deployment, which is where a Supabase project's files live",
    /**
     * Deploying to Supabase, measured 2026-09-21.
     *
     * There was no recipe here for three sessions, and the reason written
     * down was wrong: "Aime runs this CLI from a folder with no project, so
     * `functions deploy` has nothing to push". True of the resource panel,
     * never true of a deploy - a deploy runs inside the repository, which is
     * exactly where `supabase/functions/<slug>` and `supabase/migrations`
     * live. The restriction was Aime's own, and `deployOpens` in
     * `cloud/dialect.rs` lifts it for a deploy and for nothing else.
     */
    deploy: {
      target: "project",
      scopeLabel: "deploy.project",
      rules: SUPABASE_RULES,
      keepRule:
        "- When the project already serves this app, change only what you mean to: `secrets set` names " +
        "the secrets it sets and leaves the rest, while `config push` rewrites the project's settings " +
        "from `supabase/config.toml` and a file that omits something removes it. Aime reads every " +
        "setting the plan lists under `keep` before and after the deployment and reports what changed.",
      // A Supabase project's region is chosen when the project is created and
      // cannot be named on a command, so a plan never picks one.
      region: "",
      resourceId: "supabase://abcdefghijklmnopqrst/functions/hello",
      inspect: '{"purpose":"overview","label":"supabase functions list","args":["functions","list"]}',
      keep:
        '{"label":"function secrets","read":{"purpose":"overview","label":"supabase secrets list",' +
        '"args":["secrets","list"]},"path":"0.name"}',
      steps:
        '{"label":"Deploy the Edge Function","args":["functions","deploy","hello","--use-api","--no-verify-jwt"],' +
        '"changes":"the hello Edge Function on this project"},' +
        '{"label":"Apply the migrations","args":["db","push"],"changes":"the database schema of this project"}',
      prove:
        '{"read":{"purpose":"overview","label":"supabase functions list","args":["functions","list"]},' +
        '"urlPath":"","path":"/hello","expect":200}',
      // Aime builds the URL rather than reading one: no Supabase read answers
      // an endpoint, the address of an Edge Function follows from the project
      // ref, and a probe that went wherever a plan said would be a probe an
      // answer could point anywhere.
      endpoint: "https://<account>.supabase.co/functions/v1",
    },
  },
} satisfies Record<string, CloudDialect>;

/** Every cloud whose command line Aime has measured; only these offer operations. */
export const OPERABLE: ReadonlySet<string> = new Set(Object.keys(DIALECTS));

/** The clouds Aime can deploy to; only these show the Deploy button. */
export const DEPLOYABLE: ReadonlySet<string> = new Set(
  Object.entries(DIALECTS)
    .filter(([, dialect]) => "deploy" in dialect)
    .map(([id]) => id),
);

/**
 * The command line of a cloud. Callers reach this only for a cloud something
 * was offered for, so an unknown id is a bug rather than a state to render -
 * and falling back to another cloud's grammar would put its flags on this CLI.
 */
export function dialectOf(cloudId: string): CliDialect {
  const entry = entryOf(cloudId);
  if (entry === undefined) throw new Error(`Aime has not measured the ${cloudId} CLI`);
  return entry;
}

/** The deployment recipe of a cloud, for the callers that plan one. */
export function recipeOf(cloudId: string): DeployRecipe {
  const recipe = entryOf(cloudId)?.deploy;
  if (recipe === undefined) throw new Error(`Aime does not deploy to ${cloudId}`);
  return recipe;
}

function entryOf(cloudId: string): CloudDialect | undefined {
  return Object.hasOwn(DIALECTS, cloudId) ? DIALECTS[cloudId as keyof typeof DIALECTS] : undefined;
}
