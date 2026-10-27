import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  layoutProblems,
  parseScreens,
  probeScript,
  readProbe,
  VIEWPORTS,
  type LayoutReport,
} from "./layoutGate";

const [MOBILE] = VIEWPORTS;
const PAGE = "http://127.0.0.1:4173/cart";

describe("parseScreens", () => {
  it("reads how to bring the app up and which pages to open", () => {
    const screens = parseScreens(
      JSON.stringify({
        serve: [{ command: "npm run preview", dir: "", ready: "http://127.0.0.1:4173" }],
        pages: [PAGE],
      }),
    );
    expect(screens).toEqual({
      serve: [{ command: "npm run preview", dir: ".", ready: "http://127.0.0.1:4173" }],
      pages: [PAGE],
    });
  });

  it("keeps only web pages, and treats a missing serve as already running", () => {
    expect(parseScreens(JSON.stringify({ pages: [PAGE, "file:///C:/x.html", 3] }))).toEqual({
      serve: [],
      pages: [PAGE],
    });
  });

  it("refuses what is not the asked-for shape", () => {
    expect(parseScreens("{}")).toBeNull();
    expect(parseScreens("not json")).toBeNull();
  });
});

describe("probeScript", () => {
  it("is a script a page can run", () => {
    // Syntax only: what it measures needs a real layout engine, which the
    // e2e suite gives it.
    expect(() => new Script(probeScript("http://127.0.0.1:4173"))).not.toThrow();
  });

  it("answers only on the page it was sent to", () => {
    expect(probeScript("http://127.0.0.1:4173")).toContain('location.origin !== "http://127.0.0.1:4173"');
  });
});

describe("readProbe", () => {
  const report: LayoutReport = { width: 375, scrollWidth: 375, overflowing: [], clipped: [] };

  it("reads the report out of the encoded fragment", () => {
    expect(readProbe(encodeURIComponent(JSON.stringify(report)))).toEqual(report);
  });

  it("refuses an answer that is not a report", () => {
    expect(readProbe(encodeURIComponent('{"width": 375}'))).toBeNull();
    expect(readProbe("%E0%A4%A")).toBeNull();
  });
});

describe("layoutProblems", () => {
  it("is empty for a page that fits", () => {
    expect(
      layoutProblems(PAGE, MOBILE, { width: 375, scrollWidth: 375, overflowing: [], clipped: [] }),
    ).toEqual([]);
  });

  it("names the page, the width and what runs past the edge", () => {
    const problems = layoutProblems(PAGE, MOBILE, {
      width: 375,
      scrollWidth: 612,
      overflowing: [{ element: "div.totals", text: "Total 27.50", right: 612 }],
      clipped: [{ element: "button.pay", text: "Pay now with card" }],
    });
    expect(problems).toEqual([
      `mobile 375px · ${PAGE}: the page scrolls sideways (612px wide in a 375px window); div.totals reaches 612px - "Total 27.50"`,
      `mobile 375px · ${PAGE}: text cut off by its box in button.pay - "Pay now with card"`,
    ]);
  });
});
