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
 * plan, and it is only made once a real deployment has run end to end. All
 * four have both since 2026-09-22; a fifth cloud would start at the first tier
 * and stay there until a deployment of its own has really run.
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
  scopeLabel: "deploy.project" | "deploy.subscription" | "deploy.profile";
  /** The rules of the command line, as the Rust checker enforces them. */
  rules: string;
  /** What keeps a running service's settings, in this CLI's own terms. */
  keepRule: string;
  /** A `resourceId` as this cloud writes one, for the survey's example. */
  resourceId: string;
  /** A read of an existing service, for the survey's example. */
  inspect: string;
  /** The `keep`, `steps`, `files` and `prove` of a plan, in this cloud's own terms. */
  keep: string;
  steps: string;
  /**
   * The file a plan writes first, as this cloud's own kind of artifact.
   *
   * A Dockerfile is the right hint where a source build follows and the wrong
   * one on AWS, which builds nothing here and deploys a template instead - and
   * an example is the strongest instruction in a prompt.
   */
  files: string;
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

/**
 * AWS, where a deployment is a CloudFormation STACK.
 *
 * The other three clouds each have one command that takes a repository and
 * gives back a running service - `gcloud run deploy --source`, `az webapp up`,
 * `supabase functions deploy`. Measured 2026-09-22 against aws-cli 2.17.31,
 * AWS has none: every path wants an artifact built first (a zip, an image) or
 * a template, and building one needs a shell Aime will not give the AI. A
 * template is a FILE in the repository, which is exactly what the plan's
 * `files` step already writes - so the stack is the unit, and the stack's own
 * Output is the address Aime proves. It also answers the safety question
 * cleanly: a stack owns what it created and nothing else.
 */
const AWS_RULES = [
  "- A step runs as `aws` and nothing else. Never `sam`, `cdk`, `copilot`, `eb`, `terraform`, `docker`, " +
    "a shell or a script: a shape that needs one of those cannot be deployed from here, so choose what " +
    "`aws` alone can deploy and say plainly in `architecture` what you substituted for what, and what is " +
    "given up.",
  // The one rule that shapes every AWS plan, said before the grammar.
  "- A DEPLOYMENT HERE IS A CLOUDFORMATION STACK. There is no `aws` command that takes this repository " +
    "and returns a running service, so: write the template into the repository as a `files` entry, and " +
    "make `cloudformation deploy --template-file <path> --stack-name <name>` a step. Anything the stack " +
    "cannot carry - the built files of a site - goes up afterwards with `s3 sync <dir> s3://<bucket>`.",
  // Measured 2026-09-22 on a real stack: `describe-stacks` returns Outputs
  // in ALPHABETICAL order of their key, not the order the template writes
  // them - a template whose first output was `SiteUrl` came back
  // `BucketName`, `DistributionId`, `SiteUrl`. So the plan names the
  // output it wants instead of counting.
  "- The stack MUST declare an output named exactly `SiteUrl` whose value is the URL of what was " +
    "deployed, and `prove.urlPath` must be `Stacks.0.Outputs.OutputKey=SiteUrl.OutputValue` - which " +
    "picks that output BY NAME, because `describe-stacks` returns outputs in alphabetical order of " +
    "their key rather than the order the template declares them. Keep whatever other outputs are " +
    "useful; their order does not matter. A plan whose stack outputs no URL cannot be proved and " +
    "will not run.",
  // Nothing is built on this machine, so the artifact has to be a file.
  "- Nothing is built here: there is no `docker build` and no way to make a zip. So deploy the shapes " +
    "whose artifact IS a file in the repository - a static site in an S3 bucket (with CloudFront in " +
    "front of it when it needs HTTPS), or a Lambda whose handler the template carries inline " +
    "(`Code: ZipFile:`) behind a Function URL. A container image or a packaged zip is out of reach; say " +
    "so rather than planning one.",
  "- An `aws` command line is always `<service> <operation>`, both words and in that order " +
    "(`cloudformation deploy`, `s3api create-bucket`, `s3 sync`). `args` are the arguments after `aws`, " +
    "one token each: the two words, then positionals, then flags. A flag and its value are two tokens " +
    "(`--stack-name`, `web`), never `--stack-name=…`.",
  "- Aime adds `--profile` to every command and `--output json` to every read - never include them. The " +
    "region is NOT scope here: every step and every read names `--region` itself, with the region " +
    "written out.",
  // The user's rule, and the CLI's own spelling of it.
  "- ONLY MAKE NEW THINGS. The stack name must be one that is not in the account yet, and the resources " +
    "in it must be new: never take over a bucket, a table, a role or a service that is already there. " +
    "Never `delete-*`, `terminate-*`, `s3 rm` or `s3 rb`; a deployment adds and updates, and what it did " +
    "not make is not its to touch.",
  "- `--capabilities CAPABILITY_IAM` is allowed, and is how a stack that runs code gets a role of its " +
    "own - CloudFormation names that role after the stack. `CAPABILITY_NAMED_IAM` and " +
    "`CAPABILITY_AUTO_EXPAND` are refused: the first can name an identity something else already owns, " +
    "the second rewrites the template after the person has read it.",
  "- Never the `iam`, `sts`, `organizations`, `account`, `sso`, `configure`, `budgets`, `ce` or " +
    "`ec2-instance-connect` groups, and never `ssm start-session`, `ssm send-command`, " +
    "`ssm start-automation-execution` or `ecs execute-command`, which run code on a machine. Never " +
    "`--cli-input-json`, `--cli-input-yaml`, `--endpoint-url`, `--query` or `--generate-cli-skeleton`.",
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
      files: '{"path":"Dockerfile","why":"the repository has none and a source build needs one"}',
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
      files: '{"path":"Dockerfile","why":"the repository has none and the build needs one"}',
      prove:
        '{"read":{"purpose":"overview","label":"az webapp show","args":["webapp","show","--name","web",' +
        '"--resource-group","rg-web"]},"urlPath":"defaultHostName","path":"/","expect":200}',
    },
  },
  /**
   * AWS, measured 2026-09-18 against aws-cli 2.17.31, and deployable since
   * 2026-09-22.
   *
   * What kept a `deploy` out of here was never the checker - it was that no
   * `aws` command turns a repository into a running service the way
   * `gcloud run deploy --source` does. `AWS_RULES` is where that is answered:
   * the unit of a deployment here is a CloudFormation stack.
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
    deploy: {
      // A profile IS the account, so the thing a deployment happens inside is
      // the account those credentials reach.
      target: "account",
      scopeLabel: "deploy.profile",
      rules: AWS_RULES,
      keepRule:
        "- When something for this app ALREADY EXISTS, it belongs to a stack: deploy THAT stack again " +
        "by its own name, with the whole template, and CloudFormation keeps what has not changed. Never " +
        "create a second resource beside the first, and never adopt a resource that no stack owns - " +
        "name it in `keep` and leave it where it is.",
      region: "ap-southeast-2",
      resourceId: "arn:aws:cloudformation:ap-southeast-2:123456789012:stack/web/0a1b2c3d",
      inspect:
        '{"purpose":"overview","label":"aws cloudformation describe-stacks","args":["cloudformation",' +
        '"describe-stacks","--stack-name","web","--region","ap-southeast-2"]}',
      keep:
        '{"label":"the stack\'s parameters","read":{"purpose":"overview","label":"aws cloudformation describe-stacks",' +
        '"args":["cloudformation","describe-stacks","--stack-name","web","--region","ap-southeast-2"]},' +
        '"path":"Stacks.0.Parameters"}',
      steps:
        '{"label":"Deploy the stack","args":["cloudformation","deploy","--template-file","infra/site.yaml",' +
        '"--stack-name","web","--region","ap-southeast-2"],"changes":"the stack and every resource in it"},' +
        '{"label":"Upload the built site","args":["s3","sync","dist","s3://web-site-bucket","--region",' +
        '"ap-southeast-2"],"changes":"the files in the bucket"}',
      // The stack's own first output, which the template is told to make the URL.
      files: '{"path":"infra/site.yaml","why":"the CloudFormation template this stack is deployed from"}',
      prove:
        '{"read":{"purpose":"overview","label":"aws cloudformation describe-stacks","args":["cloudformation",' +
        '"describe-stacks","--stack-name","web","--region","ap-southeast-2"]},' +
        '"urlPath":"Stacks.0.Outputs.OutputKey=SiteUrl.OutputValue","path":"/","expect":200}',
    },
  },
  /**
   * Supabase, measured 2026-09-18 on the CLI 2.116.0 - the command line only.
   *
   * The panel and the deploy are two different folders here, which is the
   * whole reason this CLI took so long to deploy from: Aime runs it for the
   * panel from a work folder of its own that holds no project, so `db push`,
   * `functions deploy` and `config push` would push emptiness and are refused
   * there. A deploy runs in the repository, where they are the point.
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
      files: '{"path":"supabase/functions/hello/index.ts","why":"the function this deploy pushes"}',
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
