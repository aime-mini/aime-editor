/**
 * Pre-signed URLs, with the signature taken off before an AI sees them.
 *
 * A cloud read can answer with a URL that is itself a credential: measured on
 * AWS, `lambda get-function` returns `Code.Location` as an S3 URL whose query
 * carries `X-Amz-Credential`, `X-Amz-Signature` and a 772-character
 * `X-Amz-Security-Token` - a live session, good for ten minutes, sitting inside
 * a read every Lambda opens. The address says what the object is; the query is
 * only the permission to fetch it, so the query is what goes.
 */

/** Present in the query of every SigV4 pre-signed URL, and in no ordinary one. */
const SIGNING_PARAMETER = /(?:^|&)X-Amz-(?:Signature|Credential|Security-Token)=/i;

/**
 * A URL and its query, inside JSON or plain text. A JSON string cannot hold a
 * raw quote or whitespace, so either one ends the URL.
 */
const URL_WITH_QUERY = /(https?:\/\/[^\s"?]+)\?([^\s"]*)/g;

/** What a signed query becomes, so the reader can tell something was there. */
export const SIGNATURE_REMOVED = "<signed query removed>";

export function withoutSignatures(text: string): string {
  return text.replace(URL_WITH_QUERY, (url: string, address: string, query: string) =>
    SIGNING_PARAMETER.test(query) ? `${address}?${SIGNATURE_REMOVED}` : url,
  );
}
