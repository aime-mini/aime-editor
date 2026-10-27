import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

/**
 * An OS notification for a run that needs a person - a step waiting for an
 * answer, a run stopped at its cost limit. The system's own notification,
 * which never takes focus or covers the screen; the first one asks for
 * permission, and a refusal is remembered for the session.
 */
let allowed: boolean | null = null;

export async function notify(title: string, body: string): Promise<void> {
  if (allowed === null) {
    allowed = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  }
  if (!allowed) return;
  sendNotification({ title, body });
}
