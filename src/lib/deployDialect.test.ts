import { describe, expect, it } from "vitest";
import { DEPLOYABLE, OPERABLE, dialectOf, recipeOf } from "./deployDialect";

/**
 * The two claims this table makes are different sizes, and the panel shows a
 * different button for each.
 *
 * Reported 2026-09-18: the AWS tab's "What you can do to this" said Aime had
 * not measured the cloud's command line - true at the time - and offered an
 * "Ask the AI again" button under it that could never change the answer. The
 * command line is measured now; a whole deployment is not, and the two are
 * deliberately not the same gate.
 */
describe("what a cloud is offered", () => {
  it("offers operations for every CLI that has been measured", () => {
    for (const cloud of ["gcp", "azure", "aws", "supabase"]) {
      expect(OPERABLE.has(cloud)).toBe(true);
      expect(dialectOf(cloud).program).not.toBe("");
    }
    expect(OPERABLE.has("fly")).toBe(false);
  });

  it("offers a deployment only where one has actually been run", () => {
    expect(DEPLOYABLE.has("gcp")).toBe(true);
    expect(DEPLOYABLE.has("azure")).toBe(true);
    // AWS came in on 2026-09-22, and what it needed was not a row but a SHAPE:
    // no `aws` command turns a repository into a running service, so the unit
    // of a deployment here is a CloudFormation stack and the address Aime
    // proves is the stack's own first output.
    expect(DEPLOYABLE.has("aws")).toBe(true);
    // Supabase came in on 2026-09-21. What kept it out was a restriction of
    // Aime's own - the CLI was always run from a work folder with no project,
    // including during a deploy, which is the one time it belongs in the
    // repository where `supabase/functions` and `supabase/migrations` live.
    expect(DEPLOYABLE.has("supabase")).toBe(true);
  });

  it("refuses to hand out a recipe it does not have", () => {
    expect(() => recipeOf("fly")).toThrow(/does not deploy to fly/);
    expect(() => dialectOf("fly")).toThrow(/has not measured/);
    expect(recipeOf("azure").target).toBe("subscription");
    expect(recipeOf("supabase").target).toBe("project");
    // A profile IS the account on AWS, so that is what the confirm page names.
    expect(recipeOf("aws").target).toBe("account");
    expect(recipeOf("aws").scopeLabel).toBe("deploy.profile");
  });

  /**
   * The AWS shape, pinned where it is decided: the stack is the unit, and the
   * proof comes out of the stack's own outputs rather than from an address
   * Aime builds or an answer the plan chose.
   */
  it("proves an AWS deployment by the stack's own first output", () => {
    const aws = recipeOf("aws");
    expect(aws.endpoint).toBeUndefined();
    expect(aws.prove).toContain("cloudformation");
    // By NAME, not by position: measured on a real stack, `describe-stacks`
    // answers the outputs in alphabetical order of their key rather than the
    // order the template declares them.
    expect(aws.prove).toContain('"urlPath":"Stacks.0.Outputs.OutputKey=SiteUrl.OutputValue"');
    expect(aws.rules).toContain("A DEPLOYMENT HERE IS A CLOUDFORMATION STACK");
    // The two fences that make a stack safe to run unattended on somebody's
    // own account: only new things, and roles the stack itself owns.
    expect(aws.rules).toContain("ONLY MAKE NEW THINGS");
    expect(aws.rules).toContain("CAPABILITY_NAMED_IAM` and `CAPABILITY_AUTO_EXPAND` are refused");
    // Nothing is built on this machine, so the artifact has to be a file.
    expect(aws.rules).toContain("no `docker build`");
  });

  /**
   * Supabase has no read that answers an address, so Aime builds one - and it
   * builds it from the account, never from the plan, or a proof request would
   * go wherever an answer pointed.
   */
  it("proves a Supabase deployment at an address built from the project itself", () => {
    const endpoint = recipeOf("supabase").endpoint ?? "";
    expect(endpoint).toBe("https://<account>.supabase.co/functions/v1");
    expect(endpoint.replace("<account>", "abcdefghijklmnopqrst")).toBe(
      "https://abcdefghijklmnopqrst.supabase.co/functions/v1",
    );
    // The clouds whose reads DO answer an address must not grow one.
    expect(recipeOf("gcp").endpoint).toBeUndefined();
    expect(recipeOf("azure").endpoint).toBeUndefined();
  });

  /** Deployable is a subset of operable, never the other way round. */
  it("never claims a deployment for a CLI it cannot prove a single command on", () => {
    for (const cloud of DEPLOYABLE) expect(OPERABLE.has(cloud)).toBe(true);
  });
});

describe("each CLI's own scope", () => {
  it("names the account in that CLI's own words", () => {
    expect(dialectOf("gcp").scopeUnit).toBe("--project");
    expect(dialectOf("gcp").scopeOwner).toBe("--account");
    // `az` has no account flag, and on AWS the profile IS the account.
    expect(dialectOf("azure").scopeUnit).toBe("--subscription");
    expect(dialectOf("azure").scopeOwner).toBeUndefined();
    expect(dialectOf("aws").scopeUnit).toBe("--profile");
    expect(dialectOf("aws").scopeOwner).toBeUndefined();
    expect(dialectOf("supabase").scopeUnit).toBe("--project-ref");
  });

  /**
   * The mirror rule this file exists for: a group the Rust checker refuses
   * (`cloud/dialect.rs`) and the prompt does not name is a refusal the AI
   * cannot see coming. These four were added on 2026-09-21 after every `db`,
   * `migration`, `inspect` and `storage` command was measured against a real
   * project and answered that it needs a LINKED project, which Aime has not.
   */
  it("names the Supabase groups that cannot run without a linked project", () => {
    const supabase = dialectOf("supabase");
    for (const group of ["`db`", "`migration`", "`inspect`", "`storage`"]) {
      expect(supabase.refusedGroups).toContain(group);
    }
    expect(supabase.opsNotes.join("\n")).toContain("reaches the database itself");
  });

  it("writes every extra rule as a line the prompt can print as it stands", () => {
    for (const cloud of OPERABLE) {
      for (const note of dialectOf(cloud).opsNotes) {
        expect(note.startsWith("- ")).toBe(true);
      }
    }
  });
});
