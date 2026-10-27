import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { translate } from "../i18n";
import { failedTo } from "../stores/notices";

/**
 * Puts a path on the clipboard through the operating system rather than the
 * webview, whose clipboard refuses a window that does not have the focus.
 */
export function copyPath(path: string): void {
  writeText(path).catch(failedTo(translate("notice.copyPath")));
}
