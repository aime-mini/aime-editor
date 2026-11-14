import { describe, expect, it } from "vitest";
import { troubleIn } from "./turnTrouble";

describe("troubleIn", () => {
  it("knows a service that cannot be reached, in the words the CLIs really print", () => {
    // Claude Code 2.1.286, base URL on a closed port.
    expect(
      troubleIn("API Error: Connection refused - a firewall or proxy may be blocking it (ECONNREFUSED)"),
    ).toBe("unreachable");
    // Codex 0.146.0, backend on a closed port.
    expect(
      troubleIn(
        "stream disconnected before completion: error sending request for url (http://127.0.0.1:9/v1/responses)",
      ),
    ).toBe("unreachable");
    expect(troubleIn("Error: 529 overloaded_error: Overloaded")).toBe("unreachable");
    expect(troubleIn("You have reached your usage limit. Try again later.")).toBe("unreachable");
  });

  it("knows a sign-in that has to be done again, before anything else it says", () => {
    expect(troubleIn("Failed to authenticate: OAuth session expired and could not be refreshed")).toBe(
      "signIn",
    );
    expect(troubleIn("Not logged in · Please run /login")).toBe("signIn");
  });

  it("says nothing about a failure that is the work's own", () => {
    expect(troubleIn("TypeError: Cannot read properties of undefined (reading 'total')")).toBeNull();
    expect(troubleIn("")).toBeNull();
  });
});
