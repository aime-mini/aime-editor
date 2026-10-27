/**
 * A glob as a regular expression over workspace-relative paths written with
 * forward slashes: `src/**\/*.ts`, `*.md`, `docs/*`, `yeu-cau/**` - the forms
 * people write. `**` crosses folders, `*` and `?` stay inside one.
 *
 * Read one character at a time rather than by successive replacements: a
 * replacement that runs after another rewrites the `?` and `*` of what the
 * earlier one wrote, which is how every glob with a `**` once matched nothing.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let at = 0; at < glob.length; at += 1) {
    const char = glob[at];
    if (char === "*" && glob[at + 1] === "*") {
      const throughFolder = glob[at + 2] === "/";
      source += throughFolder ? "(?:.*/)?" : ".*";
      at += throughFolder ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}
