import {
  Activity,
  Blocks,
  Bot,
  Boxes,
  Braces,
  Container,
  Cpu,
  Database,
  FileArchive,
  Gauge,
  Globe,
  HardDrive,
  KeyRound,
  Layers,
  MapPin,
  MonitorPlay,
  Network,
  Package,
  Radio,
  Router,
  ScrollText,
  Send,
  Server,
  Shield,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * An icon per kind of cloud resource, and the grouping the list uses.
 *
 * Both are taken from what the real tools do, read out of the extensions
 * installed on this machine rather than recalled (2026-09-03):
 *
 * - `ms-azuretools.vscode-azureresourcegroups` 0.12.7 ships **69 SVGs** and maps
 *   **61 ARM provider paths** onto them - `microsoft.web/sites` has its own icon,
 *   not a generic dot - with `resource.svg` as the fallback for everything else.
 *   The ARM paths below are that map's keys.
 * - Its default grouping is **by resource type** (`azureResourceGroups.groupBy`,
 *   default `"resourceType"`), with resource group, location and tag as the
 *   other three modes. A flat list is not what either tool shows.
 * - The AWS Toolkit opens a resource as a panel of Overview / Resources /
 *   Events / Outputs, which is why the detail here is a field table rather than
 *   raw JSON.
 *
 * Microsoft's SVGs are not reused - they are their artwork, and this project
 * ships only assets it may ship. The icons are Lucide, chosen by what the
 * resource *is*, so a database looks like a database in both clouds without
 * Aime carrying anyone's brand.
 */

/** What a resource does, which is what decides its icon and its tier. */
export type Family =
  | "web"
  | "function"
  | "container"
  | "registry"
  | "kubernetes"
  | "database"
  | "cache"
  | "storage"
  | "queue"
  | "events"
  | "network"
  | "dns"
  | "cdn"
  | "loadBalancer"
  | "security"
  | "identity"
  | "monitor"
  | "logs"
  | "ai"
  | "workflow"
  | "compute"
  | "disk"
  | "notification"
  | "iot"
  | "group"
  | "other";

const FAMILY_ICONS: Record<Family, LucideIcon> = {
  web: Globe,
  function: Zap,
  container: Container,
  registry: Package,
  kubernetes: Boxes,
  database: Database,
  cache: Gauge,
  storage: HardDrive,
  queue: Send,
  events: Radio,
  network: Network,
  dns: Globe,
  cdn: Globe,
  loadBalancer: Router,
  security: Shield,
  identity: KeyRound,
  monitor: Activity,
  logs: ScrollText,
  ai: Bot,
  workflow: Workflow,
  compute: Server,
  disk: FileArchive,
  notification: MonitorPlay,
  iot: Cpu,
  group: Layers,
  other: Blocks,
};

/**
 * Azure ARM provider paths, lowercased - the same keys the Azure Resources
 * extension maps, pointed at a family instead of at its own artwork.
 */
const AZURE_FAMILIES: Record<string, Family | undefined> = {
  "microsoft.resources/resourcegroups": "group",
  "microsoft.web/sites": "web",
  "microsoft.web/staticsites": "web",
  "microsoft.web/serverfarms": "compute",
  "microsoft.web/hostingenvironments": "compute",
  "microsoft.web/kubeenvironments": "kubernetes",
  "microsoft.app/containerapps": "container",
  "microsoft.app/managedenvironments": "container",
  "microsoft.appplatform/spring": "web",
  "microsoft.compute/virtualmachines": "compute",
  "microsoft.compute/virtualmachinescalesets": "compute",
  "microsoft.compute/availabilitysets": "compute",
  "microsoft.compute/disks": "disk",
  "microsoft.compute/images": "disk",
  "microsoft.containerregistry/registries": "registry",
  "microsoft.containerservice/managedclusters": "kubernetes",
  "microsoft.kubernetes/connectedclusters": "kubernetes",
  "microsoft.documentdb/databaseaccounts": "database",
  "microsoft.documentdb/mongoclusters": "database",
  "microsoft.dbforpostgresql/flexibleservers": "database",
  "microsoft.dbforpostgresql/servers": "database",
  "microsoft.dbformysql/servers": "database",
  "microsoft.sql/servers": "database",
  "microsoft.cache/redis": "cache",
  "microsoft.storage/storageaccounts": "storage",
  "microsoft.servicebus/namespaces": "queue",
  "microsoft.eventhub/namespaces": "events",
  "microsoft.eventgrid/domains": "events",
  "microsoft.eventgrid/topics": "events",
  "microsoft.eventgrid/eventsubscriptions": "events",
  "microsoft.notificationhubs/namespaces": "notification",
  "microsoft.signalrservice/signalr": "notification",
  "microsoft.signalrservice/webpubsub": "notification",
  "microsoft.devices/iothubs": "iot",
  "microsoft.network/virtualnetworks": "network",
  "microsoft.network/networkinterfaces": "network",
  "microsoft.network/networksecuritygroups": "security",
  "microsoft.network/applicationsecuritygroups": "security",
  "microsoft.network/networkwatchers": "monitor",
  "microsoft.network/publicipaddresses": "network",
  "microsoft.network/publicipprefixes": "network",
  "microsoft.network/routetables": "network",
  "microsoft.network/virtualnetworkgateways": "loadBalancer",
  "microsoft.network/localnetworkgateways": "loadBalancer",
  "microsoft.network/loadbalancers": "loadBalancer",
  "microsoft.network/applicationgateways": "loadBalancer",
  "microsoft.cdn/profiles": "cdn",
  "microsoft.keyvault/vaults": "identity",
  "microsoft.managedidentity/userassignedidentities": "identity",
  "microsoft.insights/components": "monitor",
  "microsoft.operationalinsights/workspaces": "logs",
  "microsoft.operationsmanagement/solutions": "logs",
  "microsoft.machinelearningservices/workspaces": "ai",
  "microsoft.logic/workflows": "workflow",
  "microsoft.durabletask/schedulers": "workflow",
  "microsoft.apimanagement/service": "web",
  "microsoft.batch/batchaccounts": "compute",
  "microsoft.devtestlab/labs": "compute",
  "microsoft.servicefabric/clusters": "kubernetes",
  "microsoft.servicefabricmesh/applications": "kubernetes",
  "microsoft.extendedlocation/customlocations": "other",
  "microsoft.hybridcompute/machines": "compute",
};

/**
 * AWS services, keyed by the segment an ARN carries in position three.
 *
 * The keys came off the ARNs this machine's own account actually returned plus
 * the services a project of that shape uses; anything unlisted falls back, and
 * a fallback icon is a small loss where a wrong one is a lie.
 */
const AWS_FAMILIES: Record<string, Family | undefined> = {
  apigateway: "web",
  cloudfront: "cdn",
  s3: "storage",
  ebs: "disk",
  efs: "storage",
  backup: "disk",
  lambda: "function",
  ec2: "compute",
  ecs: "container",
  eks: "kubernetes",
  ecr: "registry",
  batch: "compute",
  rds: "database",
  dynamodb: "database",
  redshift: "database",
  elasticache: "cache",
  sqs: "queue",
  sns: "notification",
  events: "events",
  kinesis: "events",
  states: "workflow",
  cloudformation: "group",
  iam: "identity",
  kms: "identity",
  secretsmanager: "identity",
  acm: "security",
  waf: "security",
  shield: "security",
  cloudwatch: "monitor",
  logs: "logs",
  xray: "monitor",
  route53: "dns",
  elasticloadbalancing: "loadBalancer",
  sagemaker: "ai",
  bedrock: "ai",
  codebuild: "workflow",
  codepipeline: "workflow",
  ssm: "other",
  cognito: "identity",
  appsync: "web",
  amplify: "web",
  glue: "workflow",
  athena: "database",
};

/**
 * Google Cloud asset types, lowercased, as Cloud Asset Inventory spells them -
 * every key checked against the inventory's own list of searchable types
 * (docs.cloud.google.com/asset-inventory/docs/supported-asset-types,
 * 2026-09-05), not recalled. The service alone decides for most; `compute` is
 * the one service whose types span five families, so its types are named.
 */
const GCP_FAMILIES: Record<string, Family | undefined> = {
  "compute.googleapis.com/instance": "compute",
  "compute.googleapis.com/instancegroup": "compute",
  "compute.googleapis.com/instancegroupmanager": "compute",
  "compute.googleapis.com/instancetemplate": "compute",
  "compute.googleapis.com/autoscaler": "compute",
  "compute.googleapis.com/nodegroup": "compute",
  "compute.googleapis.com/disk": "disk",
  "compute.googleapis.com/regiondisk": "disk",
  "compute.googleapis.com/snapshot": "disk",
  "compute.googleapis.com/image": "disk",
  "compute.googleapis.com/machineimage": "disk",
  "compute.googleapis.com/network": "network",
  "compute.googleapis.com/subnetwork": "network",
  "compute.googleapis.com/address": "network",
  "compute.googleapis.com/globaladdress": "network",
  "compute.googleapis.com/route": "network",
  "compute.googleapis.com/router": "network",
  "compute.googleapis.com/vpngateway": "network",
  "compute.googleapis.com/vpntunnel": "network",
  "compute.googleapis.com/interconnect": "network",
  "compute.googleapis.com/networkendpointgroup": "network",
  "compute.googleapis.com/firewall": "security",
  "compute.googleapis.com/firewallpolicy": "security",
  "compute.googleapis.com/securitypolicy": "security",
  "compute.googleapis.com/sslcertificate": "security",
  "compute.googleapis.com/sslpolicy": "security",
  "compute.googleapis.com/forwardingrule": "loadBalancer",
  "compute.googleapis.com/globalforwardingrule": "loadBalancer",
  "compute.googleapis.com/backendservice": "loadBalancer",
  "compute.googleapis.com/regionbackendservice": "loadBalancer",
  "compute.googleapis.com/backendbucket": "loadBalancer",
  "compute.googleapis.com/urlmap": "loadBalancer",
  "compute.googleapis.com/targethttpproxy": "loadBalancer",
  "compute.googleapis.com/targethttpsproxy": "loadBalancer",
  "compute.googleapis.com/targettcpproxy": "loadBalancer",
  "compute.googleapis.com/targetsslproxy": "loadBalancer",
  "compute.googleapis.com/targetpool": "loadBalancer",
  "compute.googleapis.com/healthcheck": "monitor",
  "compute.googleapis.com/httphealthcheck": "monitor",
  "compute.googleapis.com/httpshealthcheck": "monitor",
  "compute.googleapis.com/project": "group",
  "cloudresourcemanager.googleapis.com/project": "group",
  "cloudresourcemanager.googleapis.com/folder": "group",
  "cloudresourcemanager.googleapis.com/organization": "group",
};

/**
 * Google Cloud services, keyed by the host an asset type starts with, for the
 * types `GCP_FAMILIES` does not name. Same source and date as above.
 */
const GCP_SERVICE_FAMILIES: Record<string, Family | undefined> = {
  "storage.googleapis.com": "storage",
  "file.googleapis.com": "storage",
  "sqladmin.googleapis.com": "database",
  "spanner.googleapis.com": "database",
  "firestore.googleapis.com": "database",
  "datastore.googleapis.com": "database",
  "bigquery.googleapis.com": "database",
  "bigtableadmin.googleapis.com": "database",
  "redis.googleapis.com": "cache",
  "memcache.googleapis.com": "cache",
  "run.googleapis.com": "container",
  "cloudfunctions.googleapis.com": "function",
  "container.googleapis.com": "kubernetes",
  "appengine.googleapis.com": "web",
  "apigateway.googleapis.com": "web",
  "artifactregistry.googleapis.com": "registry",
  "pubsub.googleapis.com": "queue",
  "cloudtasks.googleapis.com": "queue",
  "eventarc.googleapis.com": "events",
  "cloudscheduler.googleapis.com": "workflow",
  "cloudbuild.googleapis.com": "workflow",
  "workflows.googleapis.com": "workflow",
  "dataflow.googleapis.com": "workflow",
  "composer.googleapis.com": "workflow",
  "dataproc.googleapis.com": "compute",
  "secretmanager.googleapis.com": "identity",
  "cloudkms.googleapis.com": "identity",
  "iam.googleapis.com": "identity",
  "certificatemanager.googleapis.com": "security",
  "iap.googleapis.com": "security",
  "logging.googleapis.com": "logs",
  "monitoring.googleapis.com": "monitor",
  "dns.googleapis.com": "dns",
  "vpcaccess.googleapis.com": "network",
  "networkservices.googleapis.com": "network",
  "aiplatform.googleapis.com": "ai",
  "dialogflow.googleapis.com": "ai",
  "serviceusage.googleapis.com": "other",
};

/**
 * Supabase is one product, so its parts are named rather than looked up: the
 * kinds `cloud/supabase.rs` gives a project's database, its Edge Functions and
 * its preview branches. A branch is a whole copy of the project, which is a
 * grouping rather than a thing that runs or stores.
 */
const SUPABASE_FAMILIES: Record<string, Family | undefined> = {
  "supabase/database": "database",
  "supabase/function": "function",
  "supabase/branch": "group",
};

/**
 * The icon for one resource, from the `kind` its own CLI reported.
 *
 * Azure reports an ARM path (`Microsoft.Web/sites`), AWS a service and type
 * (`lambda/function`), Google Cloud an asset type
 * (`compute.googleapis.com/Instance`), and all are matched whole before
 * anything is inferred from a prefix - `microsoft.network/networksecuritygroups`
 * is security, while the rest of `microsoft.network` is networking, and a
 * prefix rule alone would get that backwards.
 */
export function iconOfKind(kind: string): LucideIcon {
  return FAMILY_ICONS[familyOfKind(kind)];
}

export function familyOfKind(kind: string): Family {
  const lower = kind.toLowerCase();
  const exact = AZURE_FAMILIES[lower] ?? GCP_FAMILIES[lower] ?? SUPABASE_FAMILIES[lower];
  if (exact !== undefined) return exact;

  // AWS arrives as `<service>` or `<service>/<type>`, Google Cloud as
  // `<host>/<Type>`; the service decides.
  const service = lower.split("/")[0] ?? "";
  const aws = AWS_FAMILIES[service];
  if (aws !== undefined) return aws;
  const gcp = GCP_SERVICE_FAMILIES[service];
  if (gcp !== undefined) return gcp;

  // An Azure type this map has never seen still gets its provider's family
  // where the provider is unambiguous, which is better than a generic block.
  if (service === "microsoft.network") return "network";
  if (service === "microsoft.compute") return "compute";
  if (service === "microsoft.storage") return "storage";
  if (service.startsWith("microsoft.dbfor") || service === "microsoft.sql") return "database";
  return "other";
}

/**
 * The colour a family is drawn in, as a Tailwind token backed by the theme.
 *
 * Grouped into nine hues rather than twenty-six: a palette nobody can tell
 * apart is a palette that carries nothing, and the eye only needs "is this
 * compute or data" at a glance. The tokens are defined for both themes in
 * `index.css`, which also records why these are Aime's own colours rather than
 * any vendor's artwork.
 */
/** The nine hues a family can be drawn in; see `index.css` for the values. */
type Hue =
  | "svc-compute"
  | "svc-data"
  | "svc-storage"
  | "svc-network"
  | "svc-security"
  | "svc-identity"
  | "svc-observe"
  | "svc-integrate"
  | "svc-other";

const FAMILY_HUES: Record<Family, Hue> = {
  web: "svc-compute",
  function: "svc-compute",
  container: "svc-compute",
  kubernetes: "svc-compute",
  compute: "svc-compute",
  database: "svc-data",
  cache: "svc-data",
  storage: "svc-storage",
  disk: "svc-storage",
  registry: "svc-storage",
  network: "svc-network",
  dns: "svc-network",
  cdn: "svc-network",
  loadBalancer: "svc-network",
  security: "svc-security",
  identity: "svc-identity",
  monitor: "svc-observe",
  logs: "svc-observe",
  queue: "svc-integrate",
  events: "svc-integrate",
  workflow: "svc-integrate",
  notification: "svc-integrate",
  ai: "svc-data",
  iot: "svc-network",
  group: "svc-other",
  other: "svc-other",
};

/**
 * The classes one resource type is drawn with.
 *
 * Written out in full rather than composed - `text-${hue}` does not survive
 * Tailwind, which scans the source for literal class names and never sees a
 * class that only exists once the string has been built at runtime. A colour
 * that silently does not apply is the worst kind of styling bug: everything
 * renders, and everything is grey.
 */
type HueClasses = { icon: string; chip: string };

const HUE_CLASSES: Record<Hue, HueClasses> = {
  "svc-compute": { icon: "text-svc-compute", chip: "bg-svc-compute/15" },
  "svc-data": { icon: "text-svc-data", chip: "bg-svc-data/15" },
  "svc-storage": { icon: "text-svc-storage", chip: "bg-svc-storage/15" },
  "svc-network": { icon: "text-svc-network", chip: "bg-svc-network/15" },
  "svc-security": { icon: "text-svc-security", chip: "bg-svc-security/15" },
  "svc-identity": { icon: "text-svc-identity", chip: "bg-svc-identity/15" },
  "svc-observe": { icon: "text-svc-observe", chip: "bg-svc-observe/15" },
  "svc-integrate": { icon: "text-svc-integrate", chip: "bg-svc-integrate/15" },
  "svc-other": { icon: "text-svc-other", chip: "bg-svc-other/15" },
};

/** The icon colour and badge background for one resource type. */
export function classesOfKind(kind: string): HueClasses {
  return HUE_CLASSES[FAMILY_HUES[familyOfKind(kind)]];
}

/**
 * Where a family sits in the path a request takes: what faces the world, what
 * runs the code, what holds the state, and what watches over all of it.
 *
 * This is the one honest thing that can be said about flow without measuring
 * it. A real dependency graph needs each service's own configuration read one
 * by one; the tier a service belongs to is a property of what it IS, so it is
 * a fact rather than a guess - and the map says so rather than drawing arrows
 * that claim more than that.
 */
export const TIERS = ["edge", "compute", "data", "support"] as const;
export type Tier = (typeof TIERS)[number];

const FAMILY_TIERS: Record<Family, Tier> = {
  web: "edge",
  dns: "edge",
  cdn: "edge",
  loadBalancer: "edge",
  network: "edge",
  function: "compute",
  container: "compute",
  kubernetes: "compute",
  compute: "compute",
  workflow: "compute",
  ai: "compute",
  database: "data",
  cache: "data",
  storage: "data",
  disk: "data",
  queue: "data",
  events: "data",
  identity: "support",
  security: "support",
  monitor: "support",
  logs: "support",
  registry: "support",
  notification: "support",
  iot: "support",
  group: "support",
  other: "support",
};

/** The tier one resource type belongs to. */
export function tierOfKind(kind: string): Tier {
  return FAMILY_TIERS[familyOfKind(kind)];
}

/**
 * The readable half of a resource type: `Microsoft.Web/sites` is `sites`,
 * `supabase/function` is `function`, and `compute.googleapis.com/Instance` is
 * `compute/Instance`.
 *
 * The provider prefix is identical on every Azure row and on every Supabase
 * row, so as a label it distinguishes nothing; `.googleapis.com` is the same
 * fourteen characters on every Google Cloud row, while the service before it
 * does distinguish (`run/Service` from `k8s.io/Service`). An AWS type carries
 * no such prefix and is left whole.
 */
export function shortKind(kind: string): string {
  const slash = kind.indexOf("/");
  if (slash === -1) return kind;
  const lower = kind.toLowerCase();
  if (lower.startsWith("microsoft.") || lower.startsWith("supabase/")) return kind.slice(slash + 1);
  return kind.replace(GOOGLE_API_HOST, "");
}

/** The suffix every Google Cloud service host carries. */
const GOOGLE_API_HOST = ".googleapis.com";

/** How the list is divided. Azure Resources defaults to type; so does this. */
export const GROUPINGS = ["kind", "group", "location"] as const;
export type Grouping = (typeof GROUPINGS)[number];

/** The icon for a group heading, which says what the heading is *of*. */
export function iconOfGrouping(grouping: Grouping): LucideIcon {
  return grouping === "kind" ? Braces : grouping === "group" ? Layers : MapPin;
}
