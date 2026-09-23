import { describe, expect, it } from "vitest";
import { SIGNATURE_REMOVED, withoutSignatures } from "./signedUrls";

/**
 * The parameters, in order, of a URL `aws s3 presign` produced on this machine
 * (aws-cli, temporary credentials, 2026-09-23); the values are stand-ins of the
 * same kind, because the real ones are a credential.
 */
const SIGNED =
  "https://aime-fixture-bucket.s3.ap-southeast-2.amazonaws.com/code.zip" +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
  "&X-Amz-Credential=ASIAEXAMPLE%2F20260923%2Fap-southeast-2%2Fs3%2Faws4_request" +
  "&X-Amz-Date=20260923T070000Z" +
  "&X-Amz-Expires=600" +
  "&X-Amz-SignedHeaders=host" +
  "&X-Amz-Security-Token=IQoJb3JpZ2luX2VjEXAMPLE" +
  "&X-Amz-Signature=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("a pre-signed URL on its way to the AI", () => {
  it("keeps the address and loses the permission to fetch it", () => {
    const answer = JSON.stringify({ Code: { RepositoryType: "S3", Location: SIGNED } }, null, 2);
    const shared = withoutSignatures(answer);

    expect(shared).toContain(
      `https://aime-fixture-bucket.s3.ap-southeast-2.amazonaws.com/code.zip?${SIGNATURE_REMOVED}`,
    );
    expect(shared).not.toContain("X-Amz-Security-Token");
    expect(shared).not.toContain("X-Amz-Signature");
    // Still the JSON it was, so the reader can parse it.
    expect(JSON.parse(shared)).toHaveProperty("Code.RepositoryType", "S3");
  });

  it("leaves a URL alone when its query is not a signature", () => {
    const ordinary = '{"url":"https://console.aws.amazon.com/lambda/home?region=ap-southeast-2#/functions"}';
    expect(withoutSignatures(ordinary)).toBe(ordinary);
  });

  it("finds every signed URL, not only the first", () => {
    const two = `first ${SIGNED} and second ${SIGNED}`;
    expect(withoutSignatures(two).match(/signed query removed/g)).toHaveLength(2);
  });
});
