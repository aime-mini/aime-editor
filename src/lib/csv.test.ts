import { describe, expect, it } from "vitest";
import { detectDelimiter, isDelimitedFile, parseCsv } from "./csv";

describe("reading a delimited file as a table", () => {
  it("honours quotes: delimiters, line breaks and doubled quotes inside a field", () => {
    const table = parseCsv('name,note,price\r\n"Smith, John","said ""hi""\nthen left",12.50\r\nAnn,,3\r\n');
    expect(table.delimiter).toBe(",");
    expect(table.header).toEqual(["name", "note", "price"]);
    expect(table.rows).toEqual([
      ["Smith, John", 'said "hi"\nthen left', "12.50"],
      ["Ann", "", "3"],
    ]);
  });

  /** A spreadsheet saved in a Vietnamese or European locale writes `;` and still calls it .csv. */
  it("finds the delimiter the file is consistent about", () => {
    expect(detectDelimiter("a;b;c\n1;2;3\n4;5;6\n")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2\n")).toBe("\t");
    expect(detectDelimiter("a|b|c\nx|y|z\n")).toBe("|");
    // A comma inside a quoted field does not make the file comma-separated.
    expect(detectDelimiter('id;label\n1;"a, b"\n2;"c, d"\n')).toBe(";");
    // One column and no delimiter at all falls back to the comma.
    expect(detectDelimiter("just\nlines\n")).toBe(",");
  });

  it("pads a ragged row instead of refusing the file, and drops blank lines", () => {
    const table = parseCsv("a,b,c\n1,2\n\n4,5,6,7\n");
    expect(table.header).toEqual(["a", "b", "c", ""]);
    expect(table.rows).toEqual([
      ["1", "2", "", ""],
      ["4", "5", "6", "7"],
    ]);
  });

  it("tells a column of numbers from a column of words", () => {
    const table = parseCsv("sku,qty,price,city\nA1,3,1.234,56,Hà Nội\nB2,10,$4.00,Huế\nC3,,12%,Đà Nẵng\n");
    // `1.234,56` split on the comma: the file is ragged there, which is the file's problem.
    expect(table.numeric.slice(0, 2)).toEqual([false, true]);
    expect(parseCsv("n\n1\n2\nx\n").numeric).toEqual([false]);
    expect(parseCsv("n\n1\n2\n3\n4\n5\n6\n7\n8\n9\nx\n").numeric).toEqual([true]);
  });

  it("has nothing to say about an empty file", () => {
    expect(parseCsv("")).toEqual({ delimiter: ",", header: [], rows: [], numeric: [] });
  });

  it("knows which files it is for", () => {
    expect(isDelimitedFile("data/sales.CSV")).toBe(true);
    expect(isDelimitedFile("x.tsv")).toBe(true);
    expect(isDelimitedFile("x.csv.bak")).toBe(false);
    expect(isDelimitedFile("README.md")).toBe(false);
  });
});
