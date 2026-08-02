import type * as Monaco from "monaco-editor";

/**
 * What language a file is, answered by Monaco's own registry.
 *
 * Monaco bundles tokenizers for ~80 languages, so all of them get highlighting,
 * folding, bracket matching and comment toggling with nothing installed.
 * Asking the registry instead of keeping a hand-written table means a Monaco
 * upgrade adds languages to Aime for free, and the editor can never disagree
 * with itself about what a file is - the same answer drives both the colouring
 * and which language server to start.
 */

/** Where Aime deliberately differs from - or fills a gap in - the registry. */
const OVERRIDES: Record<string, string> = {
  // Monaco ships no TOML grammar; INI is close enough to stay readable.
  toml: "ini",
};

interface Lookup {
  byExtension: Map<string, string>;
  byFilename: Map<string, string>;
}

let lookup: Lookup | null = null;

/**
 * Fills the table from Monaco's registry.
 *
 * Called by `lib/monaco.ts` as soon as Monaco is loaded, which keeps this
 * module free of a static import of it - the one thing that would drag 4.4 MB
 * onto the welcome screen, where no file is open and no language is needed.
 */
export function primeLanguages(api: typeof Monaco): void {
  const byExtension = new Map<string, string>();
  const byFilename = new Map<string, string>();

  for (const language of api.languages.getLanguages()) {
    for (const extension of language.extensions ?? []) {
      byExtension.set(extension.replace(/^\./, "").toLowerCase(), language.id);
    }
    for (const filename of language.filenames ?? []) {
      byFilename.set(filename.toLowerCase(), language.id);
    }
    for (const pattern of language.filenamePatterns ?? []) {
      // Patterns look like "Dockerfile*"; the stem is what a user actually types.
      byFilename.set(pattern.replace(/\*.*$/, "").toLowerCase(), language.id);
    }
  }
  for (const [extension, id] of Object.entries(OVERRIDES)) byExtension.set(extension, id);

  lookup = { byExtension, byFilename };
}

/** The table, or nothing when Monaco has not been loaded yet. */
const EMPTY: Lookup = { byExtension: new Map(), byFilename: new Map() };

export function languageOf(path: string): string {
  const { byExtension, byFilename } = lookup ?? EMPTY;
  const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  // A file is known by its whole name (Dockerfile, Makefile) or by its suffix.
  const byName = byFilename.get(name);
  if (byName) return byName;
  const extension = name.includes(".") ? (name.split(".").pop() ?? "") : "";
  return byExtension.get(extension) ?? "plaintext";
}

/**
 * How many languages this build highlights out of the box.
 *
 * Zero until Monaco has loaded - the welcome screen asks for this number, and
 * loading four megabytes to print it would be exactly backwards. The caller
 * that shows it loads Monaco in the background and asks again.
 */
export function supportedLanguageCount(): number {
  return lookup === null ? 0 : new Set(lookup.byExtension.values()).size;
}
