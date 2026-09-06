import { describe, expect, it } from "vitest";
import { connectionRows, countOf, propertiesOf } from "./cloudProperties";

describe("turning a CLI answer into properties a person reads", () => {
  /** The shape `aws rds describe-db-clusters` answers with: a list of one under a plural key. */
  it("unwraps a list of one under a plural key", () => {
    const rows = propertiesOf(
      JSON.stringify({
        DBClusters: [
          {
            DBClusterIdentifier: "shop-prod",
            Endpoint: "shop-prod.cluster-x.ap-southeast-2.rds.amazonaws.com",
            Port: 5432,
          },
        ],
      }),
    );
    expect(rows).toEqual([
      { key: "DBClusterIdentifier", kind: "value", value: "shop-prod" },
      { key: "Endpoint", kind: "value", value: "shop-prod.cluster-x.ap-southeast-2.rds.amazonaws.com" },
      { key: "Port", kind: "value", value: "5432" },
    ]);
  });

  /** The shape `aws lambda get-function` answers with: several top-level sections, kept as groups. */
  it("keeps several sections as folded groups and flattens plain lists", () => {
    const rows = propertiesOf(
      JSON.stringify({
        Configuration: {
          FunctionName: "fn",
          Runtime: "dotnet8",
          Layers: ["a", "b"],
          Environment: { Variables: { A: "1" } },
        },
        Code: { RepositoryType: "S3" },
        Tags: {},
      }),
    );
    expect(rows.map((row) => [row.key, row.kind])).toEqual([
      ["Configuration", "group"],
      ["Code", "group"],
      ["Tags", "value"],
    ]);
    const configuration = rows[0];
    if (configuration.kind !== "group") throw new Error("expected a group");
    expect(configuration.rows).toEqual([
      { key: "FunctionName", kind: "value", value: "fn" },
      { key: "Runtime", kind: "value", value: "dotnet8" },
      { key: "Layers", kind: "value", value: "a, b" },
      {
        key: "Environment",
        kind: "group",
        rows: [{ key: "Variables", kind: "group", rows: [{ key: "A", kind: "value", value: "1" }] }],
      },
    ]);
    expect(countOf(rows)).toBe(6);
  });

  it("keeps an answer that is not JSON as the text it was", () => {
    expect(propertiesOf("Unable to locate credentials")).toEqual([
      { key: "", kind: "value", value: "Unable to locate credentials" },
    ]);
  });

  it("pulls out whatever the payload calls an endpoint", () => {
    const rows = propertiesOf(
      JSON.stringify({
        properties: {
          defaultHostName: "shop.azurewebsites.net",
          state: "Running",
          siteConfig: { linuxFxVersion: "DOTNETCORE|8.0", connectionStrings: null },
        },
        FunctionUrl: "https://abc.lambda-url.ap-southeast-2.on.aws/",
        Port: 5432,
      }),
    );
    expect(connectionRows(rows).map((row) => row.key)).toEqual(["defaultHostName", "FunctionUrl", "Port"]);
  });
});
