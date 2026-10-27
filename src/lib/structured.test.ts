import { describe, expect, it } from "vitest";
import { jsonStructure, xmlStructure } from "./structured";

describe("a JSON file as rows", () => {
  it("folds objects and lists of objects, and reads a list of values as one line", () => {
    const result = jsonStructure(
      '{"name":"aime","version":2,"tags":["a","b"],"deps":{"react":"19"},"list":[{"id":1},{"id":2}],"none":null,"empty":{}}',
    );
    expect(result).toEqual({
      kind: "ok",
      count: 8,
      rows: [
        { key: "name", kind: "value", value: "aime" },
        { key: "version", kind: "value", value: "2" },
        { key: "tags", kind: "value", value: "a, b" },
        { key: "deps", kind: "group", rows: [{ key: "react", kind: "value", value: "19" }] },
        {
          key: "list",
          kind: "group",
          rows: [
            { key: "1", kind: "group", rows: [{ key: "id", kind: "value", value: "1" }] },
            { key: "2", kind: "group", rows: [{ key: "id", kind: "value", value: "2" }] },
          ],
        },
        { key: "none", kind: "value", value: "null" },
        { key: "empty", kind: "value", value: "{}" },
      ],
    });
  });

  it("says what is wrong with a file that is not JSON", () => {
    const result = jsonStructure('{"a": }');
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).toMatch(/JSON/);
  });
});

describe("an XML file as rows", () => {
  it("shows attributes as @name, text as #text, and a leaf as one line", () => {
    const xml = `<?xml version="1.0"?>
<!-- a comment -->
<project sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Serilog" Version="3.1" />
  </ItemGroup>
  <Note>Tom &amp; Jerry <![CDATA[<raw>]]></Note>
</project>`;
    expect(xmlStructure(xml)).toEqual({
      kind: "ok",
      count: 6,
      rows: [
        {
          key: "project",
          kind: "group",
          rows: [
            { key: "@sdk", kind: "value", value: "Microsoft.NET.Sdk" },
            {
              key: "PropertyGroup",
              kind: "group",
              rows: [
                { key: "TargetFramework", kind: "value", value: "net8.0" },
                { key: "Nullable", kind: "value", value: "enable" },
              ],
            },
            {
              key: "ItemGroup",
              kind: "group",
              rows: [
                {
                  key: "PackageReference",
                  kind: "group",
                  rows: [
                    { key: "@Include", kind: "value", value: "Serilog" },
                    { key: "@Version", kind: "value", value: "3.1" },
                  ],
                },
              ],
            },
            { key: "Note", kind: "value", value: "Tom & Jerry<raw>" },
          ],
        },
      ],
    });
  });

  it("names the tag a broken file leaves open or closes wrongly", () => {
    expect(xmlStructure("<a><b></a>")).toEqual({ kind: "invalid", reason: "</a> closes <b>" });
    expect(xmlStructure("<a><b/>")).toEqual({ kind: "invalid", reason: "<a> is never closed" });
    expect(xmlStructure("<a").kind).toBe("invalid");
  });
});
