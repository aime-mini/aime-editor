import { describe, expect, it } from "vitest";
import { SECURITY_RULES } from "./securityRules";

describe("SECURITY_RULES", () => {
  it("covers every category of the OWASP Top 10:2025", () => {
    for (const category of ["A01", "A02", "A03", "A04", "A05", "A06", "A07", "A08", "A09", "A10"]) {
      expect(SECURITY_RULES).toContain(`${category} `);
    }
  });
});
