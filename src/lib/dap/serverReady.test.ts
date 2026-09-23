import { describe, expect, it } from "vitest";
import { servingAddress, watchForServer } from "./serverReady";

/** Lines captured from the real servers on this machine, 2026-09-23. */
const ASPNET = "info: Microsoft.Hosting.Lifetime[14]\r\n      Now listening on: http://0.0.0.0:5987\r\n";
const VITE =
  "  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5991\u001b[22m/\u001b[39m\n";

describe("a server announcing itself", () => {
  it("is opened on localhost when it bound every interface", () => {
    expect(servingAddress(ASPNET)).toBe("http://localhost:5987");
  });

  it("is read through the colour codes a dev server puts inside its address", () => {
    expect(servingAddress(VITE)).toBe("http://localhost:5991/");
  });

  it("keeps a path and drops the full stop of a sentence", () => {
    expect(servingAddress("Serving at http://127.0.0.1:8000/admin.")).toBe("http://127.0.0.1:8000/admin");
  });

  it("reads ASP.NET's own wildcard hosts as localhost too", () => {
    expect(servingAddress("Now listening on: http://+:5000")).toBe("http://localhost:5000");
    expect(servingAddress("Now listening on: https://*:5001")).toBe("https://localhost:5001");
  });

  it("is not a remote address the program happened to print", () => {
    expect(servingAddress("fetching https://api.example.com/v1/items")).toBeNull();
    expect(servingAddress("total 6")).toBeNull();
  });
});

describe("a session's output, heard piece by piece", () => {
  it("opens once, with the whole address, even when it arrives split", () => {
    const opened: string[] = [];
    const hear = watchForServer((address) => opened.push(address));
    hear("      Now listening on: http://0.0.0.0:59");
    expect(opened).toEqual([]);
    hear("87\r\n");
    hear("      Now listening on: http://0.0.0.0:5988\r\n");

    expect(opened).toEqual(["http://localhost:5987"]);
  });
});
