/**
 * The security rules every task run hands the AI that writes code and the AI
 * that reviews it.
 *
 * Packaged rather than left to the model's taste, and taken from the sources
 * the industry measures itself by - read 2026-10-01:
 * - OWASP Top 10:2025 (top10.owasp.org/2025), whose order the groups follow;
 * - CWE Top 25 Most Dangerous Software Weaknesses 2025 (cwe.mitre.org/top25);
 * - the OWASP Cheat Sheet Series: Authorization, Password Storage, Secrets
 *   Management, File Upload, SSRF Prevention (cheatsheetseries.owasp.org);
 * - OWASP ASVS 5.0 (May 2025) for the rest of what a reviewer checks.
 *
 * Nothing here needs a tool installed: it is what the code must and must not
 * do, which the writer follows and the reviewer checks line by line.
 */
export const SECURITY_RULES = `Security rules for this change - OWASP Top 10:2025 and CWE Top 25 (2025). Apply every rule that
can apply to the code you touch; a reviewer checks each one and a broken rule is a security finding.

A01 Broken access control (CWE-862, 863, 284, 639, 22, 352, 918)
- Deny by default. Check authorisation on the server for every request, for the specific object asked
  for, not only its type: an id taken from the request must be checked against the caller (IDOR).
- Never rely on the client, a hidden field or an unguessable id for access control.
- Build file paths from validated names only; reject "..", absolute paths and separators (path traversal).
- State-changing requests are protected against CSRF (same-site cookies plus a token, or a header check).
- A URL fetched on a user's behalf is built from an allowlist, never taken whole from input; no redirects
  followed; private, loopback and metadata addresses (169.254.169.254) refused (SSRF).

A02 Security misconfiguration
- No debug mode, stack traces, default credentials or sample endpoints reachable in production config.
- Security headers and cookie flags: Secure, HttpOnly, SameSite on session cookies; a restrictive CORS
  list, never "*" with credentials.

A03 Software supply chain failures
- Add a dependency only when it is needed, from the official registry, at a deliberate, pinned version
  recorded in the lockfile. Never a version with a known advisory (CVE / GHSA) you know of.
- No code fetched and executed at runtime from a URL; no install scripts piped from the internet.

A04 Cryptographic failures (CWE-200)
- Passwords: Argon2id (m=19456 KiB, t=2, p=1), else scrypt (N=2^17, r=8, p=1), else bcrypt (cost >= 10),
  PBKDF2-HMAC-SHA256 with 600,000 iterations only where FIPS demands it. Never MD5, SHA-1 or a plain hash.
- Use the platform's vetted crypto library and a CSPRNG; no home-made crypto, no hard-coded IVs or keys.
- TLS for anything leaving the machine; never disable certificate validation.
- Secrets never in source, config committed to git, logs, error messages or URLs: read them from the
  environment or the platform's secret store. Tokens, keys, connection strings and private keys in a
  diff are a finding.

A05 Injection (CWE-79, 89, 78, 77, 94)
- SQL only through parameterised queries or the ORM's bound parameters; never string-built SQL.
- Output is encoded for its context (HTML, attribute, JS, URL); no innerHTML / dangerouslySetInnerHTML /
  v-html with data that is not sanitised by a vetted library (XSS).
- No shell built from input: call the program with an argument list; never eval / new Function / exec
  of input (command and code injection).

A06 Insecure design (CWE-770)
- Limits on everything an outsider can make the server do: rate limits on login and expensive
  endpoints, size limits on bodies, uploads and pagination, timeouts on outbound calls.
- Validate input at the boundary against an allowlist schema: type, length, range, format (CWE-20).

A07 Authentication failures (CWE-306, 287)
- Every function that changes or reveals data requires authentication; none is reachable anonymously
  by accident.
- Sessions: regenerated on login, invalidated on logout, with an expiry. Login errors do not say which
  of user or password was wrong.

A08 Software or data integrity failures (CWE-502, 434)
- Never deserialise data from a caller you do not control into objects (pickle, BinaryFormatter,
  native Java serialisation, YAML load with tags); parse plain data and validate it.
- Uploads: allowlist of extensions checked with the file's signature too, a server-generated name,
  a size limit, stored outside the web root, with authentication on the upload.

A09 Security logging and alerting failures
- Log authentication and authorisation decisions and failures, without secrets, tokens or personal
  data in the message.

A10 Mishandling of exceptional conditions (CWE-476)
- Handle errors where they occur and fail closed: a failed check denies, a failed transaction rolls
  back entirely. Never swallow an error; never return internal details to the caller.

Memory-unsafe code (C, C++, unsafe Rust) (CWE-787, 125, 416, 120, 121, 122)
- Bounds-checked access, no use after free, no unchecked copies into fixed buffers.`;
