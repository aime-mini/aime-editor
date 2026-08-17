/**
 * Teaching Aime a new AI CLI, by asking an AI.
 *
 * Aime drives any headless CLI through a description in `providers.json`
 * (ARCHITECTURE.md §4, §7) — but writing that description by hand means reading
 * someone's `--help` and guessing which flag streams JSON. That is exactly the
 * kind of errand this editor is supposed to run for the user: the agent probes
 * the real binary, writes the entry, and Aime picks the file up by itself.
 *
 * The prompt below is deliberately explicit about the schema. An agent that
 * invents a field name produces a provider that silently does nothing, and the
 * user would have no way to see why.
 */

export interface AddProviderRequest {
  /** What the user typed: a CLI name ("gemini") or a sentence naming one. */
  wanted: string;
  /** Absolute path of the `providers.json` the agent must edit. */
  configPath: string;
}

/** Every field of the Rust `ProviderConfig`, in the agent's own words. */
const SCHEMA = [
  '- `id` (string, required): short lowercase identifier, e.g. "gemini". Must be unique in the file.',
  '- `displayName` (string, required): what the user sees, e.g. "Gemini CLI".',
  "- `command` (string, required): the executable, resolved through PATH. No arguments here.",
  "- `args` (string[], required): arguments for one turn. `{prompt}` is replaced with the prompt, " +
    "`{model}` with the chosen model. An argument containing `{model}` is dropped whole when no model is " +
    'set, so a flag and its placeholder must share one argument - `"--model={model}"`, never ' +
    '`["--model", "{model}"]`, which would leave a dangling `--model` behind.',
  "- `promptStdin` (boolean): send the prompt on stdin instead of substituting `{prompt}`. " +
    "**Strongly preferred** whenever the CLI can read a prompt from stdin: on Windows every CLI runs " +
    "through `cmd /C`, which cuts a command line at the first newline, so a multi-line prompt passed " +
    "as an argument arrives with every line but the first missing.",
  "- `resumeArgs` (string[]): appended when continuing a conversation; `{sessionId}` is substituted. " +
    "Leave `[]` if the CLI cannot resume - Aime then simply starts a fresh conversation each turn.",
  '- `parser` ("plain" | "jsonl"): "plain" means everything the CLI prints is the answer. Use "jsonl" ' +
    "only if the CLI emits one JSON object per line, and then set `textField` to the field holding the text.",
  '- `textField` (string): for `jsonl`, the field carrying assistant text (default "text").',
  '- `login` (string): the CLI\'s own sign-in command, run in an Aime terminal, e.g. "gemini auth login".',
  '- `install` (string): how to install the CLI, e.g. "npm install -g @google/gemini-cli".',
  "- `apiKeyEnv` (string): the environment variable the CLI reads an API key from, if it reads one. " +
    "Aime then offers a key field and passes the key to its own runs only.",
  "- `apiKeyLoginArgs` (string[]): use this **instead** of `apiKeyEnv` when the CLI stores keys itself " +
    'and takes one on stdin, e.g. `["login", "--with-api-key"]`. Leave both out if it takes no key.',
  '- `memory` ("native" | "config-pointer" | "prompt-inject"): how the CLI finds project knowledge. ' +
    '"native" = it reads a context file of its own; "config-pointer" = its context filename is ' +
    'configurable; "prompt-inject" = it has no such convention, so Aime prepends AGENTS.md to prompts. ' +
    'When unsure, "prompt-inject" always works.',
  '- `memoryFile` (string): for the first two, that file relative to the home directory, e.g. ".gemini/GEMINI.md".',
].join("\n");

/**
 * The brief. It asks for evidence rather than a plausible-looking entry: an
 * unverified config is worse than none, because it fails at the user's first
 * real prompt instead of here.
 */
export function buildAddProviderPrompt(request: AddProviderRequest): string {
  const { wanted, configPath } = request;
  return [
    `I am Aime, a desktop code editor that talks to headless AI CLIs. The user wants to use this one: ${wanted}`,
    "",
    "I drive any CLI through a description in my own config file, so nothing about me needs to change - " +
      "but the description has to be right, and only the real binary can tell you that.",
    "",
    "Do this:",
    "1. Find out whether that CLI is on this machine (`<command> --version`). If it is not installed, " +
      "install it the way its own documentation says, or stop and tell me the command I should show the user.",
    "2. Read its actual interface - `--help`, and the help of any relevant subcommand. Do not rely on memory: " +
      "flags change between versions, and a wrong flag here fails silently at the user's first prompt.",
    "3. Run it once, non-interactively, with a trivial prompt, and look at what it prints. That answers " +
      "`parser`, `textField` and `promptStdin` - guessing them does not.",
    `4. Write the entry into ${configPath}. That file is a JSON array. **Keep every entry already in it** ` +
      "and add yours, or correct the existing entry if one for this CLI is already there.",
    "",
    "The schema, exactly:",
    SCHEMA,
    "",
    "Rules I care about:",
    "- Only fields from that list. An invented field is ignored, so the provider would half-work with no explanation.",
    "- The file must stay valid JSON. If it does not parse I lose every configured provider, so re-read it " +
      "after writing and confirm it parses.",
    "- Do not put an API key, a token or any secret in this file - only the name of the variable or the login " +
      "arguments. The user types the key into my settings.",
    "- Ask me rather than push through anything that needs the user's decision: a paid plan, a licence, " +
      "an administrator prompt or a multi-gigabyte download.",
    "",
    "When you are done, tell me in one or two lines which CLI you added, which parser you chose and why, and " +
      "how you verified it. I re-read the file by myself the moment you save it, so the user does not restart anything.",
  ].join("\n");
}
