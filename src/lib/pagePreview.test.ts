import { describe, expect, it } from "vitest";
import { pageAddress, previewRootOf } from "./pagePreview";

describe("previewRootOf", () => {
  it("fences a page into the workspace that holds it", () => {
    expect(previewRootOf("C:\\site\\pages\\about.html", "C:\\site")).toBe("C:\\site");
  });

  it("fences a page from elsewhere into its own folder", () => {
    expect(previewRootOf("/home/me/Downloads/report.html", "/home/me/site")).toBe("/home/me/Downloads");
    expect(previewRootOf("/tmp/page.html", null)).toBe("/tmp");
  });
});

describe("pageAddress", () => {
  it("keeps every folder a segment, so relative addresses resolve beside the page", () => {
    const address = pageAddress(
      "http://aime-page.localhost/",
      "ab12",
      "C:\\site",
      "C:\\site\\pages\\about.html",
    );
    expect(address).toBe("http://aime-page.localhost/ab12/pages/about.html");
    expect(new URL("../css/app.css", address).href).toBe("http://aime-page.localhost/ab12/css/app.css");
  });

  it("escapes what a folder or file name may hold", () => {
    expect(pageAddress("aime-page://localhost/", "t", "/s", "/s/my page/#1.html")).toBe(
      "aime-page://localhost/t/my%20page/%231.html",
    );
  });
});
