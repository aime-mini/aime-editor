import { useAi } from "../stores/ai";
import { runInTerminal } from "../stores/terminals";

/** The selected CLI's own sign-in, ready to start. */
export interface SignIn {
  /** The command the terminal runs, e.g. `claude auth login`. */
  command: string;
  start: () => void;
}

/**
 * Starts the selected CLI's sign-in in a terminal tab and watches for it to
 * finish. It runs whatever the CLI already reports, so a sign-in that expired
 * behind a status still saying "signed in" can be done again.
 *
 * Null when the CLI names no sign-in command - a provider configured in
 * providers.json may leave `login` empty - so nothing offers an empty terminal.
 */
export function useSignIn(): SignIn | null {
  const command = useAi((s) => s.loginCommand);
  const watchSignIn = useAi((s) => s.watchSignIn);
  if (command === "") return null;
  return {
    command,
    start: () => {
      runInTerminal(command);
      // The CLI signs in on its own schedule; poll until it reports success.
      watchSignIn();
    },
  };
}
