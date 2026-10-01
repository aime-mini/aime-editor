import { describe, expect, it } from "vitest";
import {
  commandFor,
  describeFinding,
  newFindings,
  parseSarif,
  parseScanners,
  sarifPathFor,
  type Scanner,
  type SecurityFinding,
} from "./securityGate";

const ROOT = "C:/work/shop";

const gitleaks: Scanner = {
  label: "gitleaks",
  command: "gitleaks dir . --report-format sarif --report-path {sarif} --no-banner",
  dir: ".",
};
const osv: Scanner = {
  label: "osv-scanner",
  command: "osv-scanner scan source --format sarif --output-file {sarif} .",
  dir: ".",
};

/**
 * Result objects as Gitleaks 8.30.1 and OSV-Scanner 2.6.0 wrote them
 * (2026-10-01, a sample with a pinned lodash 4.17.15 and a token in a file);
 * only the machine's folder is replaced by ROOT.
 */
const GITLEAKS_RESULT = {
  message: { text: "github-pat has detected secret for file src/config.ts." },
  ruleId: "github-pat",
  locations: [
    {
      physicalLocation: {
        artifactLocation: { uri: "src/config.ts" },
        region: { startLine: 3, startColumn: 18, endLine: 3, endColumn: 57, snippet: { text: "ghp_…" } },
      },
    },
  ],
  partialFingerprints: { commitSha: "", email: "", author: "", date: "", commitMessage: "" },
  properties: { tags: [] },
};

const osvResult = (cve: string) => ({
  partialFingerprints: { primaryLocationLineHash: "4b708835d07ff30a" },
  kind: "fail",
  level: "warning",
  locations: [
    {
      annotations: [],
      id: -1,
      logicalLocations: [],
      physicalLocation: { artifactLocation: { index: -1, uri: `file:///${ROOT}/package-lock.json` } },
      relationships: [],
    },
  ],
  message: { arguments: [], text: `Package 'lodash@4.17.15' is vulnerable to '${cve}'.` },
  ruleId: cve,
  ruleIndex: 0,
});

const log = (...results: unknown[]) => JSON.stringify({ version: "2.1.0", runs: [{ results }] });

/** The findings of a log the test knows to be valid. */
function read(text: string, scanner: Scanner): SecurityFinding[] {
  const found = parseSarif(text, scanner, ROOT);
  if (found === null) throw new Error("not a SARIF log");
  return found;
}

describe("parseScanners", () => {
  it("reads the scanners the AI wrote down", () => {
    const setup = parseScanners(JSON.stringify({ scanners: [gitleaks, { ...osv, dir: "" }] }));
    expect(setup).toEqual({ scanners: [gitleaks, { ...osv, dir: "." }], reason: "" });
  });

  it("drops a scanner that would not write where Aime reads", () => {
    const setup = parseScanners(
      JSON.stringify({ scanners: [{ label: "semgrep", command: "semgrep scan" }] }),
    );
    expect(setup?.scanners).toEqual([]);
  });

  it("keeps the reason when none could be set up", () => {
    expect(parseScanners('{"scanners": [], "reason": "offline"}')).toEqual({
      scanners: [],
      reason: "offline",
    });
  });

  it("refuses what is not the asked-for shape", () => {
    expect(parseScanners("not json")).toBeNull();
    expect(parseScanners('{"tools": []}')).toBeNull();
  });
});

describe("the command and its file", () => {
  it("names a file per scanner and pass, under .aime/security", () => {
    expect(sarifPathFor("C:\\work\\shop\\", osv, "before")).toBe(
      "C:/work/shop/.aime/security/osv-scanner-before.sarif",
    );
  });

  it("puts that file where the command asked for it, quoted for a folder with a space", () => {
    expect(commandFor(gitleaks, "C:/Front end/a.sarif")).toBe(
      'gitleaks dir . --report-format sarif --report-path "C:/Front end/a.sarif" --no-banner',
    );
  });
});

describe("parseSarif", () => {
  it("reads a relative location with its line", () => {
    expect(parseSarif(log(GITLEAKS_RESULT), gitleaks, ROOT)).toEqual([
      {
        scanner: "gitleaks",
        rule: "github-pat",
        file: "src/config.ts",
        line: 3,
        message: "github-pat has detected secret for file src/config.ts.",
      },
    ]);
  });

  it("makes an absolute file URI relative to the run's root", () => {
    const [finding] = read(log(osvResult("CVE-2020-28500")), osv);
    expect(finding).toMatchObject({ file: "package-lock.json", line: null, rule: "CVE-2020-28500" });
  });

  it("places a relative location under the folder the scanner ran in", () => {
    const [finding] = read(log(GITLEAKS_RESULT), { ...gitleaks, dir: "web" });
    expect(finding.file).toBe("web/src/config.ts");
  });

  it("ignores what it finds in Aime's own folder, where the old logs are", () => {
    const echo = {
      ...GITLEAKS_RESULT,
      locations: [
        { physicalLocation: { artifactLocation: { uri: ".aime/security/gitleaks-before.sarif" } } },
      ],
    };
    expect(parseSarif(log(echo), gitleaks, ROOT)).toEqual([]);
  });

  it("answers null for text that is not a SARIF log", () => {
    expect(parseSarif("Error: no such command", gitleaks, ROOT)).toBeNull();
    expect(parseSarif('{"findings": []}', gitleaks, ROOT)).toBeNull();
  });
});

describe("newFindings", () => {
  const finding = (rule: string, line: number | null = 1): SecurityFinding => ({
    scanner: "osv-scanner",
    rule,
    file: "package-lock.json",
    line,
    message: `vulnerable to ${rule}`,
  });

  it("is empty when the change brought nothing in", () => {
    expect(newFindings([finding("A")], [finding("A")])).toEqual([]);
  });

  it("does not blame the change for a finding an edit only moved", () => {
    expect(newFindings([finding("A", 3)], [finding("A", 9)])).toEqual([]);
  });

  it("names what appeared with the change", () => {
    expect(newFindings([finding("A")], [finding("A"), finding("B")])).toEqual([finding("B")]);
  });

  it("counts a repeated finding, so one more copy of an old one is new", () => {
    expect(newFindings([finding("A")], [finding("A"), finding("A")])).toEqual([finding("A")]);
  });
});

describe("describeFinding", () => {
  it("says where, which scanner and rule, and what", () => {
    const [secret] = read(log(GITLEAKS_RESULT), gitleaks);
    expect(describeFinding(secret)).toBe(
      "src/config.ts:3 [gitleaks github-pat] github-pat has detected secret for file src/config.ts.",
    );
  });
});
