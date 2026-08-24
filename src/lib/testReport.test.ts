import { describe, expect, it } from "vitest";
import { compareRuns, isRegression, readTestOutput } from "./testReport";

/**
 * Both fixtures are real output, captured from real failing runs rather than
 * written from memory: the cargo one from this project's own suite while the
 * headless runner was being built, the vitest one from a sample project run
 * for the purpose. A format nobody has measured has no reader here.
 */

const CARGO_FAILING = `
running 7 tests
test exec::tests::a_capture_is_cut_on_a_character_boundary ... ok
test exec::tests::a_command_that_cannot_start_says_so_instead_of_answering ... ok
test exec::tests::the_two_streams_stay_apart ... ok
test exec::tests::lines_are_handed_over_while_the_command_is_still_running ... ok
test exec::tests::an_exit_code_is_the_process_s_own_not_a_printed_line ... ok
test exec::tests::cancelling_ends_it_and_says_that_is_what_happened ... ok
test exec::tests::a_command_that_will_not_end_is_ended ... FAILED

failures:

---- exec::tests::a_command_that_will_not_end_is_ended stdout ----

thread 'exec::tests::a_command_that_will_not_end_is_ended' (22576) panicked at src\\exec.rs:371:9:
it waited 61034 ms for a 300 ms deadline

failures:
    exec::tests::a_command_that_will_not_end_is_ended

test result: FAILED. 6 passed; 1 failed; 0 ignored; 0 measured; 250 filtered out; finished in 61.08s
`;

const CARGO_PASSING = CARGO_FAILING.replace(
  "test exec::tests::a_command_that_will_not_end_is_ended ... FAILED",
  "test exec::tests::a_command_that_will_not_end_is_ended ... ok",
)
  .replace(/failures:[\s\S]*$/, "")
  .concat("\ntest result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 250 filtered out;\n");

const VITEST_FAILING = `
 RUN  v4.1.11 C:/…/sample-app

 ❯ src/cart.test.js (4 tests | 1 failed) 14ms
     × this one is meant to fail 8ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/cart.test.js > withTax > this one is meant to fail
AssertionError: expected 27.5 to be 999 // Object.is equality

 Test Files  1 failed (1)
      Tests  1 failed | 3 passed (4)
   Duration  2.13s
`;

const VITEST_PASSING = `
 RUN  v4.1.11 C:/…/sample-app

 ✓ src/cart.test.js (4 tests) 12ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Duration  1.9s
`;

/**
 * `dotnet test` over a solution holding two test projects — xunit and MSTest —
 * captured 2026-08-23 on SDK 9/10. One run, two assemblies, and the two
 * frameworks name a test differently: xunit fully qualified with the theory
 * arguments, MSTest the bare method. Only the paths are shortened.
 */
const DOTNET_FAILING = `
Test run for C:\\…\\Ms.Tests.dll (.NETCoreApp,Version=v9.0)
A total of 1 test files matched the specified pattern.
[xUnit.net 00:00:00.15]     Shop.Tests.CartTests.Discount_never_goes_negative(amount: 1) [FAIL]
[xUnit.net 00:00:00.16]     Shop.Tests.CartTests.WithTax_rounds_to_cents [FAIL]
  Skipped Shop.Tests.CheckoutTests.Refund_restores_stock [1 ms]
  Failed Shop.Tests.CartTests.Discount_never_goes_negative(amount: 1) [< 1 ms]
  Error Message:
   Assert.True() Failure
Expected: True
Actual:   False
  Stack Trace:
     at Shop.Tests.CartTests.Discount_never_goes_negative(Int32 amount) in C:\\…\\CartTests.cs:line 16
   at InvokeStub_CartTests.Discount_never_goes_negative(Object, Span\`1)
  Failed Shop.Tests.CartTests.WithTax_rounds_to_cents [1 ms]
  Error Message:
   Assert.Equal() Failure: Values differ
Expected: 2
Actual:   3
  Stack Trace:
     at Shop.Tests.CartTests.WithTax_rounds_to_cents() in C:\\…\\CartTests.cs:line 11

Failed!  - Failed:     2, Passed:     3, Skipped:     1, Total:     6, Duration: 17 ms - Sample.Tests.dll (net9.0)
  Failed Rounds_down [9 ms]
  Error Message:
   Assert.AreEqual failed. Expected:<2>. Actual:<3>.
  Stack Trace:
     at Shop.Ms.PriceTests.Rounds_down() in C:\\…\\PriceTests.cs:line 12

  Failed Never_negative (1) [< 1 ms]
  Error Message:
   Assert.IsTrue failed.

Failed!  - Failed:     2, Passed:     2, Skipped:     0, Total:     4, Duration: 33 ms - Ms.Tests.dll (net9.0)
`;

const DOTNET_PASSING = `
Test run for C:\\…\\Sample.Tests.dll (.NETCoreApp,Version=v9.0)
A total of 1 test files matched the specified pattern.
[xUnit.net 00:00:01.22]     Shop.Tests.CheckoutTests.Refund_restores_stock [SKIP]
  Skipped Shop.Tests.CheckoutTests.Refund_restores_stock [1 ms]

Passed!  - Failed:     0, Passed:     5, Skipped:     1, Total:     6, Duration: 254 ms - Sample.Tests.dll (net9.0)
`;

describe("readTestOutput", () => {
  it("reads cargo's own words, and counts every test rather than the tail", () => {
    const report = readTestOutput(CARGO_FAILING, 101);
    expect(report.reader).toBe("cargo");
    expect(report.passed).toBe(false);
    expect(report.failed).toEqual(["exec::tests::a_command_that_will_not_end_is_ended"]);
    // The failure is printed three times in that output; it is one test.
    expect(report.failed).toHaveLength(1);
    expect(report.total).toBe(7);
  });

  it("reads vitest, keeping the path that tells two tests of the same name apart", () => {
    const report = readTestOutput(VITEST_FAILING, 1);
    expect(report.reader).toBe("vitest");
    expect(report.passed).toBe(false);
    expect(report.failed).toEqual(["src/cart.test.js > withTax > this one is meant to fail"]);
    expect(report.total).toBe(4);
  });

  it("reads dotnet across every assembly of a solution, not just the last one", () => {
    const report = readTestOutput(DOTNET_FAILING, 1);
    expect(report.reader).toBe("dotnet");
    expect(report.passed).toBe(false);
    // As each framework printed it: xunit qualifies and carries the theory
    // arguments, MSTest hands over the bare method.
    expect(report.failed).toEqual([
      "Shop.Tests.CartTests.Discount_never_goes_negative(amount: 1)",
      "Shop.Tests.CartTests.WithTax_rounds_to_cents",
      "Rounds_down",
      "Never_negative (1)",
    ]);
    expect(report.total).toBe(10);
  });

  it("does not read dotnet's own `Failed!` summary as a test that failed", () => {
    const report = readTestOutput(DOTNET_PASSING, 0);
    expect(report.reader).toBe("dotnet");
    expect(report.passed).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.total).toBe(6);
  });

  it("says nothing about a dotnet run that never reached the runner", () => {
    // A real MSBuild refusal: the suite did not run, so there is no failing set
    // to speak of - and inventing an empty one would read as "all green".
    const report = readTestOutput(
      "MSBUILD : error MSB1009: Project file does not exist.\nSwitch: Shop.sln",
      1,
    );
    expect(report.reader).toBeNull();
    expect(report.total).toBeNull();
  });

  it("sees through the colours a terminal leaves behind", () => {
    const coloured = VITEST_FAILING.replace("FAIL", "\u001B[41m\u001B[30mFAIL\u001B[0m");
    expect(readTestOutput(coloured, 1).failed).toEqual([
      "src/cart.test.js > withTax > this one is meant to fail",
    ]);
  });

  it("says it could not read an output rather than reporting no failures", () => {
    // A runner nobody has measured. The verdict still stands; the detail does
    // not exist, and `failed: []` here must never be read as "nothing failed".
    const report = readTestOutput("=== 3 tests, 1 broke ===", 1);
    expect(report.reader).toBeNull();
    expect(report.passed).toBe(false);
    expect(report.failed).toEqual([]);
    expect(report.total).toBeNull();
  });

  it("treats a killed run as a failure, whatever it managed to print", () => {
    expect(readTestOutput(CARGO_PASSING, null).passed).toBe(false);
  });
});

describe("compareRuns", () => {
  const before = readTestOutput(CARGO_FAILING, 101);
  const after = readTestOutput(CARGO_PASSING, 0);

  it("does not blame a change for damage that was already there", () => {
    // The same test failing on both sides: real, reported, and not blocking.
    const stillBroken = compareRuns(before, before);
    expect(stillBroken.broken).toEqual([]);
    expect(stillBroken.alreadyBroken).toHaveLength(1);
    expect(isRegression(stillBroken)).toBe(false);
  });

  it("blocks on a test that was passing and is not any more", () => {
    const regressed = compareRuns(after, before);
    expect(regressed.broken).toEqual(["exec::tests::a_command_that_will_not_end_is_ended"]);
    expect(isRegression(regressed)).toBe(true);
  });

  it("says so when a change fixed something", () => {
    const fixed = compareRuns(before, after);
    expect(fixed.repaired).toEqual(["exec::tests::a_command_that_will_not_end_is_ended"]);
    expect(fixed.broken).toEqual([]);
    expect(isRegression(fixed)).toBe(false);
  });

  it("still blocks when the verdict got worse and no reader could say why", () => {
    const green = readTestOutput("all good", 0);
    const red = readTestOutput("something went wrong", 1);
    const worse = compareRuns(green, red);
    expect(worse.broken).toEqual([]);
    expect(worse.brokeWithoutDetail).toBe(true);
    expect(isRegression(worse)).toBe(true);
  });

  it("does not count a named regression twice", () => {
    const named = compareRuns(readTestOutput(VITEST_PASSING, 0), readTestOutput(VITEST_FAILING, 1));
    expect(named.broken).toHaveLength(1);
    expect(named.brokeWithoutDetail).toBe(false);
  });
});
