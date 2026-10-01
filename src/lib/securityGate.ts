/**
 * The security gate of a task run: real scanners, chosen by the AI for this
 * project, run by Aime before and after the change.
 *
 * Aime does not know which scanners fit a repository it has never seen - a
 * Rust service and a Django app share none - so the AI picks them, installs
 * what is missing and writes them down (`.aime/security/scanners.json`). What
 * Aime does not leave to the AI is the verdict: every scanner writes SARIF,
 * the one format static analysers, dependency auditors and secret scanners all
 * speak, and Aime reads the findings out of it and compares them itself. A
 * finding that was there before the change is the project's; one that appears
 * with it is the change's, and the run is not done while one remains.
 */

/** Where the run keeps its scanners and what they wrote, inside the project's `.aime/`. */
export const SECURITY_DIR = ".aime/security";
export const SCANNERS_FILE = `${SECURITY_DIR}/scanners.json`;

/** What a scanner command has in place of the SARIF file Aime asks it to write. */
export const SARIF_PLACEHOLDER = "{sarif}";

/** One scanner as the AI wrote it down: a command line, and where it runs. */
export interface Scanner {
  label: string;
  /** One line for this machine's shell, holding {@link SARIF_PLACEHOLDER} once. */
  command: string;
  /** Where it runs, relative to the root of the run's tree. */
  dir: string;
}

/** What the AI wrote down: the scanners, or why there are none. */
export interface ScannerSetup {
  scanners: Scanner[];
  /** Said when no scanner could be set up on this machine. */
  reason: string;
}

/** One thing a scanner reported, as Aime compares it. */
export interface SecurityFinding {
  scanner: string;
  rule: string;
  /** Relative to the root of the run's tree, with forward slashes. */
  file: string;
  /** Null for a finding about a whole file - a lockfile pinning a vulnerable package. */
  line: number | null;
  message: string;
}

/**
 * The project's security as the scanners saw it before the change, and what
 * could not be measured. Kept on the run, so a run picked up again is measured
 * against the same thing.
 */
export interface SecurityPass {
  scanners: Scanner[];
  findings: SecurityFinding[];
  /** Why there is no measurement at all, when there is none. */
  unavailable: string;
}

/** Reads `scanners.json`; null when it is not the shape the setup prompt asks for. */
export function parseScanners(text: string): ScannerSetup | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { scanners, reason } = value as { scanners?: unknown; reason?: unknown };
  if (!Array.isArray(scanners)) return null;
  const valid = scanners.flatMap((one: unknown): Scanner[] => {
    if (typeof one !== "object" || one === null) return [];
    const { label, command, dir } = one as { label?: unknown; command?: unknown; dir?: unknown };
    if (typeof label !== "string" || typeof command !== "string" || !command.includes(SARIF_PLACEHOLDER)) {
      return [];
    }
    return [{ label, command, dir: typeof dir === "string" && dir !== "" ? dir : "." }];
  });
  return { scanners: valid, reason: typeof reason === "string" ? reason : "" };
}

/**
 * The file a scanner writes for one pass. Named per pass, so a scanner that
 * fails to write leaves no older answer in place to be misread as this one.
 */
export function sarifPathFor(root: string, scanner: Scanner, pass: string): string {
  const slug = scanner.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `${trimSlashes(root)}/${SECURITY_DIR}/${slug}-${pass}.sarif`;
}

/**
 * The scanner's command with the file it must write filled in - quoted here,
 * because the project's folder may have a space in it and double quotes mean
 * the same to cmd.exe and to sh.
 */
export function commandFor(scanner: Scanner, sarifPath: string): string {
  return scanner.command.replaceAll(SARIF_PLACEHOLDER, `"${sarifPath}"`);
}

/** The minimum of SARIF 2.1.0 this reads; every field is optional, as tools differ. */
interface SarifLog {
  runs?: {
    results?: {
      ruleId?: string;
      message?: { text?: string };
      locations?: {
        physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } };
      }[];
    }[];
  }[];
}

/**
 * The findings in one SARIF log, or null when the text is not one.
 *
 * Measured on real logs (2026-10-01): Gitleaks names files relative to where
 * it ran, OSV-Scanner as absolute `file:///C:/…` URIs with no line at all, and
 * both are made relative to the run's root here so the two passes compare.
 * Anything inside `.aime/` is dropped: the logs live there, and a secret
 * scanner reads the secret it reported last time back out of the old log.
 */
export function parseSarif(text: string, scanner: Scanner, root: string): SecurityFinding[] | null {
  let log: SarifLog;
  try {
    log = JSON.parse(text) as SarifLog;
  } catch {
    return null;
  }
  if (!Array.isArray(log.runs)) return null;
  return log.runs.flatMap((run) =>
    (run.results ?? []).flatMap((result): SecurityFinding[] => {
      const location = result.locations?.[0]?.physicalLocation;
      const file = relativeFile(location?.artifactLocation?.uri ?? "", scanner.dir, root);
      if (file.startsWith(".aime/")) return [];
      return [
        {
          scanner: scanner.label,
          rule: result.ruleId ?? "",
          file,
          line: location?.region?.startLine ?? null,
          message: result.message?.text ?? "",
        },
      ];
    }),
  );
}

/**
 * What the change brought in: every finding after it that the project did not
 * already have before.
 *
 * Compared without the line, which any edit above a finding moves, and as a
 * count, because a scanner repeats itself - OSV-Scanner lists one advisory
 * twice for one package - and a second copy of an old finding is a new one.
 */
export function newFindings(
  before: readonly SecurityFinding[],
  after: readonly SecurityFinding[],
): SecurityFinding[] {
  const known = new Map<string, number>();
  for (const finding of before) known.set(keyOf(finding), (known.get(keyOf(finding)) ?? 0) + 1);
  return after.filter((finding) => {
    const left = known.get(keyOf(finding)) ?? 0;
    if (left === 0) return true;
    known.set(keyOf(finding), left - 1);
    return false;
  });
}

/** One finding as one line: where it is, which scanner and rule, and what it says. */
export function describeFinding(finding: SecurityFinding): string {
  const where = finding.line === null ? finding.file : `${finding.file}:${String(finding.line)}`;
  return `${where} [${finding.scanner} ${finding.rule}] ${finding.message}`;
}

function keyOf(finding: SecurityFinding): string {
  return [finding.scanner, finding.rule, finding.file, finding.message].join("\u0000");
}

function trimSlashes(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** A SARIF URI as a path from the run's root: `src/a.ts`, whatever form the tool wrote. */
function relativeFile(uri: string, dir: string, root: string): string {
  const decoded = decodeURIComponent(uri.replace(/^file:\/\//, "")).replace(/\\/g, "/");
  // `file:///C:/x` leaves `/C:/x`; the drive is the start of the path.
  const path = /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
  const base = trimSlashes(root);
  if (path.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return path.slice(base.length + 1);
  const isAbsolute = path.startsWith("/") || /^[A-Za-z]:\//.test(path);
  if (isAbsolute || dir === "." || dir === "") return path;
  return `${trimSlashes(dir)}/${path}`;
}
