import { describe, expect, it } from "vitest";
import { compareRuns, isRegression, readTestOutput } from "./testReport";

/**
 * Every fixture is real output, captured from real failing runs rather than
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

/**
 * Jest 30.5, Playwright 1.63 and pytest 9.1, captured 2026-09-25 from sample
 * projects run with their output piped - the way Aime runs a suite, so no TTY
 * and Jest's all on stderr. Code frames and stack lines inside the scratch
 * folder are cut and the folder itself is shortened; every line a reader looks
 * at is as the runner printed it. The Playwright run used two projects' worth
 * of config, `--retries=1` and one test that passes only on its retry.
 */
const JEST_FAILING = `
FAIL src/cart.test.js
  ● cart › rounds to cents

    expect(received).toBe(expected) // Object.is equality

    Expected: 0.3
    Received: 0.30000000000000004

      at Object.toBe (src/cart.test.js:3:51)

  ● cart › discount › never goes negative

    expect(received).toBeGreaterThanOrEqual(expected)

    Expected: >= 0
    Received:    -1

      at Object.toBeGreaterThanOrEqual (src/cart.test.js:5:50)

FAIL src/util.test.js
  ● parses money

    expect(received).toBe(expected) // Object.is equality

    Expected: 2
    Received: 1.5

      at Object.toBe (src/util.test.js:2:52)

FAIL src/broken.test.js
  ● Test suite failed to run

    Jest encountered an unexpected token

    Jest failed to parse a file. This happens e.g. when your code or its dependencies use non-standard JavaScript syntax, or when Jest is not configured to support such syntax.

    Out of the box Jest supports Babel, which will be used to transform your files into valid JS based on your Babel configuration.

    By default "node_modules" folder is ignored by transformers.

    Here's what you can do:
     • If you are trying to use TypeScript, see https://jestjs.io/docs/getting-started#using-typescript
     • To have some of your "node_modules" files transformed, you can specify a custom "transformIgnorePatterns" in your config.
     • If you need a custom transformation, specify a "transform" option in your config.
     • If you simply want to mock your non-JS modules (e.g. binary assets) you can stub them out with the "moduleNameMapper" config option.

    You'll find more details and examples of these config options in the docs:
    https://jestjs.io/docs/configuration
    For information about custom transformations, see:
    https://jestjs.io/docs/code-transformation

    Details:

    SyntaxError: C:\\…\\jest\\src\\broken.test.js: Illegal newline after throw. (1:43)

      at constructor (node_modules/@babel/parser/src/parse-error.ts:96:45)
          at parser.next (<anonymous>)
          at normalizeFile.next (<anonymous>)
          at run.next (<anonymous>)
          at transform.next (<anonymous>)

Test Suites: 3 failed, 1 passed, 4 total
Tests:       3 failed, 3 passed, 6 total
Snapshots:   0 total
Time:        2.392 s, estimated 8 s
Ran all test suites.

`;

const PLAYWRIGHT_FAILING = `

Running 5 tests using 2 workers

[1/5] [chromium] › tests\\cart.spec.ts:3:7 › cart › adds two items
[2/5] [chromium] › tests\\flaky.spec.ts:2:5 › sometimes fails
[3/5] [chromium] › tests\\cart.spec.ts:4:7 › cart › rounds to cents
[4/5] (retries) [chromium] › tests\\flaky.spec.ts:2:5 › sometimes fails (retry #1)
  1) [chromium] › tests\\flaky.spec.ts:2:5 › sometimes fails ────────────────────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 1
    Received: 0

    Error Context: test-results\\flaky-sometimes-fails-chromium\\error-context.md

[5/5] [chromium] › tests\\flaky.spec.ts:3:6 › not yet
[6/5] (retries) [chromium] › tests\\cart.spec.ts:4:7 › cart › rounds to cents (retry #1)
  2) [chromium] › tests\\cart.spec.ts:4:7 › cart › rounds to cents ──────────────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 0.3
    Received: 0.30000000000000004

    Error Context: test-results\\cart-cart-rounds-to-cents-chromium\\error-context.md

    Retry #1 ───────────────────────────────────────────────────────────────────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 0.3
    Received: 0.30000000000000004

    Error Context: test-results\\cart-cart-rounds-to-cents-chromium-retry1\\error-context.md

[7/5] [chromium] › tests\\cart.spec.ts:6:5 › login shows error
[8/5] (retries) [chromium] › tests\\cart.spec.ts:6:5 › login shows error (retry #1)
  3) [chromium] › tests\\cart.spec.ts:6:5 › login shows error ───────────────────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: "b"
    Received: "a"

    Error Context: test-results\\cart-login-shows-error-chromium\\error-context.md

    Retry #1 ───────────────────────────────────────────────────────────────────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: "b"
    Received: "a"

    Error Context: test-results\\cart-login-shows-error-chromium-retry1\\error-context.md

  2 failed
    [chromium] › tests\\cart.spec.ts:4:7 › cart › rounds to cents ───────────────────────────────────
    [chromium] › tests\\cart.spec.ts:6:5 › login shows error ────────────────────────────────────────
  1 flaky
    [chromium] › tests\\flaky.spec.ts:2:5 › sometimes fails ─────────────────────────────────────────
  1 skipped
  1 passed (14.1s)

`;

const PLAYWRIGHT_FLAKY_GREEN = `

Running 2 tests using 1 worker

  ✘  1 [chromium] › tests\\flaky.spec.ts:2:5 › sometimes fails (53ms)
  ✓  2 [chromium] › tests\\flaky.spec.ts:2:5 › sometimes fails (retry #1) (23ms)
  -  3 [chromium] › tests\\flaky.spec.ts:3:6 › not yet

  1) [chromium] › tests\\flaky.spec.ts:2:5 › sometimes fails ────────────────────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 1
    Received: 0

    Error Context: test-results\\flaky-sometimes-fails-chromium\\error-context.md

  1 flaky
    [chromium] › tests\\flaky.spec.ts:2:5 › sometimes fails ─────────────────────────────────────────
  1 skipped

`;

const PYTEST_FAILING = `
============================= test session starts =============================
platform win32 -- Python 3.12.2, pytest-9.1.1, pluggy-1.6.0
rootdir: C:\\…\\py
collected 8 items

tests\\test_cart.py .FF.FsF                                               [ 87%]
tests\\test_setup.py E                                                    [100%]

=================================== ERRORS ====================================
_____________________ ERROR at setup of test_reads_orders _____________________

    @pytest.fixture
    def db():
>       raise ConnectionError("no database")
E       ConnectionError: no database

tests\\test_setup.py:5: ConnectionError
================================== FAILURES ===================================
____________________________ test_rounds_to_cents _____________________________

    def test_rounds_to_cents():
>       assert 0.1 + 0.2 == 0.3
E       assert (0.1 + 0.2) == 0.3

tests\\test_cart.py:7: AssertionError
______________________ TestDiscount.test_never_negative _______________________

self = <test_cart.TestDiscount object at 0x00000199F36713D0>

    def test_never_negative(self):
>       assert -1 >= 0
E       assert -1 >= 0

tests\\test_cart.py:11: AssertionError
_______________________________ test_amounts[2] _______________________________

amount = 2

    @pytest.mark.parametrize("amount", [1, 2])
    def test_amounts(amount):
>       assert amount == 1
E       assert 2 == 1

tests\\test_cart.py:15: AssertionError
_________________________________ test_errors _________________________________

    def test_errors():
>       raise RuntimeError("boom")
E       RuntimeError: boom

tests\\test_cart.py:22: RuntimeError
=========================== short test summary info ===========================
FAILED tests/test_cart.py::test_rounds_to_cents - assert (0.1 + 0.2) == 0.3
FAILED tests/test_cart.py::TestDiscount::test_never_negative - assert -1 >= 0
FAILED tests/test_cart.py::test_amounts[2] - assert 2 == 1
FAILED tests/test_cart.py::test_errors - RuntimeError: boom
ERROR tests/test_setup.py::test_reads_orders - ConnectionError: no database
=============== 4 failed, 2 passed, 1 skipped, 1 error in 0.14s ===============

`;

const PYTEST_QUIET = `
.FF.FsF                                                                  [100%]
================================== FAILURES ===================================
____________________________ test_rounds_to_cents _____________________________

    def test_rounds_to_cents():
>       assert 0.1 + 0.2 == 0.3
E       assert (0.1 + 0.2) == 0.3

tests\\test_cart.py:7: AssertionError
______________________ TestDiscount.test_never_negative _______________________

self = <test_cart.TestDiscount object at 0x000001A4F75816A0>

    def test_never_negative(self):
>       assert -1 >= 0
E       assert -1 >= 0

tests\\test_cart.py:11: AssertionError
_______________________________ test_amounts[2] _______________________________

amount = 2

    @pytest.mark.parametrize("amount", [1, 2])
    def test_amounts(amount):
>       assert amount == 1
E       assert 2 == 1

tests\\test_cart.py:15: AssertionError
_________________________________ test_errors _________________________________

    def test_errors():
>       raise RuntimeError("boom")
E       RuntimeError: boom

tests\\test_cart.py:22: RuntimeError
=========================== short test summary info ===========================
FAILED tests/test_cart.py::test_rounds_to_cents - assert (0.1 + 0.2) == 0.3
FAILED tests/test_cart.py::TestDiscount::test_never_negative - assert -1 >= 0
FAILED tests/test_cart.py::test_amounts[2] - assert 2 == 1
FAILED tests/test_cart.py::test_errors - RuntimeError: boom
4 failed, 2 passed, 1 skipped in 0.73s

`;

const PYTEST_WONT_IMPORT = `
============================= test session starts =============================
platform win32 -- Python 3.12.2, pytest-9.1.1, pluggy-1.6.0
rootdir: C:\\…\\py
collected 8 items / 1 error

=================================== ERRORS ====================================
________________ ERROR collecting tests/test_broken_import.py _________________
ImportError while importing test module 'C:\\…\\py\\tests\\test_broken_import.py'.
Hint: make sure your test modules/packages have valid Python names.
Traceback:
C:\\Python312\\Lib\\importlib\\__init__.py:90: in import_module
    return _bootstrap._gcd_import(name[level:], package, level)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
tests\\test_broken_import.py:1: in <module>
    import not_a_module
E   ModuleNotFoundError: No module named 'not_a_module'
=========================== short test summary info ===========================
ERROR tests/test_broken_import.py
!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!
============================== 1 error in 0.60s ===============================

`;

const PYTEST_PASSING = `
============================= test session starts =============================
platform win32 -- Python 3.12.2, pytest-9.1.1, pluggy-1.6.0
rootdir: C:\\…\\py
collected 7 items / 5 deselected / 2 selected

tests\\test_cart.py .s                                                    [100%]

================= 1 passed, 1 skipped, 5 deselected in 0.02s ==================

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

  it("reads jest, naming each failure after its file and keeping a file that would not load", () => {
    const report = readTestOutput(JEST_FAILING, 1);
    expect(report.reader).toBe("jest");
    expect(report.failed).toEqual([
      "src/cart.test.js › cart › rounds to cents",
      "src/cart.test.js › cart › discount › never goes negative",
      "src/util.test.js › parses money",
      "src/broken.test.js › Test suite failed to run",
    ]);
    expect(report.total).toBe(6);
  });

  it("reads playwright's epilogue, leaving out a test that only passed on its retry", () => {
    const report = readTestOutput(PLAYWRIGHT_FAILING, 1);
    expect(report.reader).toBe("playwright");
    expect(report.failed).toEqual([
      "[chromium] › tests\\cart.spec.ts › cart › rounds to cents",
      "[chromium] › tests\\cart.spec.ts › login shows error",
    ]);
    expect(report.total).toBe(5);
  });

  it("does not call a playwright run that ended flaky a failure of any test", () => {
    const report = readTestOutput(PLAYWRIGHT_FLAKY_GREEN, 0);
    expect(report.reader).toBe("playwright");
    expect(report.passed).toBe(true);
    expect(report.failed).toEqual([]);
  });

  it("matches a playwright test across a change that moved it down the file", () => {
    const moved = PLAYWRIGHT_FAILING.replaceAll("cart.spec.ts:4:7", "cart.spec.ts:9:7");
    const comparison = compareRuns(readTestOutput(PLAYWRIGHT_FAILING, 1), readTestOutput(moved, 1));
    expect(comparison.broken).toEqual([]);
    expect(comparison.alreadyBroken).toHaveLength(2);
  });

  it("reads pytest's short summary, a fixture that broke included, and drops the assertion text", () => {
    const report = readTestOutput(PYTEST_FAILING, 1);
    expect(report.reader).toBe("pytest");
    expect(report.failed).toEqual([
      "tests/test_cart.py::test_rounds_to_cents",
      "tests/test_cart.py::TestDiscount::test_never_negative",
      "tests/test_cart.py::test_amounts[2]",
      "tests/test_cart.py::test_errors",
      "tests/test_setup.py::test_reads_orders",
    ]);
    expect(report.total).toBe(8);
  });

  it("reads pytest -q, whose summary has no frame around it", () => {
    const report = readTestOutput(PYTEST_QUIET, 1);
    expect(report.reader).toBe("pytest");
    expect(report.failed).toHaveLength(4);
    expect(report.total).toBe(7);
  });

  it("names the pytest file that would not import, the one thing that ran", () => {
    const report = readTestOutput(PYTEST_WONT_IMPORT, 2);
    expect(report.failed).toEqual(["tests/test_broken_import.py"]);
    expect(report.total).toBe(1);
  });

  it("does not count tests pytest deselected", () => {
    const report = readTestOutput(PYTEST_PASSING, 0);
    expect(report.reader).toBe("pytest");
    expect(report.failed).toEqual([]);
    expect(report.total).toBe(2);
  });

  it("leaves each runner's output to its own reader", () => {
    const readers = [JEST_FAILING, PLAYWRIGHT_FAILING, PYTEST_FAILING, VITEST_FAILING, DOTNET_FAILING].map(
      (output) => readTestOutput(output, 1).reader,
    );
    expect(readers).toEqual(["jest", "playwright", "pytest", "vitest", "dotnet"]);
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
