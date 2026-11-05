import { describe, expect, it } from "vitest";
import { asksToSignInAgain } from "./signInAsked";

describe("asksToSignInAgain", () => {
  it("recognises the errors the built-in CLIs print once their sign-in expired", () => {
    // Captured from real runs against a stored login whose refresh token was revoked.
    expect(
      asksToSignInAgain("Failed to authenticate: OAuth session expired and could not be refreshed"),
    ).toBe(true);
    expect(
      asksToSignInAgain("Your access token could not be refreshed. Please log out and sign in again."),
    ).toBe(true);
    expect(asksToSignInAgain("Not logged in · Please run /login")).toBe(true);
  });

  it("recognises the wording another CLI's sign-in failure would use", () => {
    expect(asksToSignInAgain("the AI CLI exited with 1\nError: 401 Unauthorized")).toBe(true);
    expect(asksToSignInAgain("Your session has expired. Log in again to continue.")).toBe(true);
    expect(asksToSignInAgain("Credentials were revoked; please re-authenticate")).toBe(true);
  });

  it("leaves every other failure alone", () => {
    expect(asksToSignInAgain("API Error: Connection refused")).toBe(false);
    expect(asksToSignInAgain("the AI CLI exited with 1")).toBe(false);
    expect(asksToSignInAgain("Rate limit reached for requests")).toBe(false);
    expect(asksToSignInAgain("stream disconnected before completion")).toBe(false);
  });
});
