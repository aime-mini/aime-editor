import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/**
 * Listens to an event the backend sends to this workspace alone: its
 * terminals' output, its language servers and debug adapters, its folder's
 * file changes, its close.
 *
 * Several workspaces share a window, one webview each, and the backend
 * addresses such events to one of them (`EventTarget::webview`). A plain
 * `listen` would still hear all of them: Tauri hands a listener registered
 * for any target every event, whatever it was addressed to - measured
 * 2026-09-26, a file written in one tab's folder reached the other tab too.
 * Registered for this webview, a listener hears only what was sent to it,
 * and still everything sent to all.
 */
export function listenHere<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  return listen<T>(event, handler, { target: { kind: "Webview", label: getCurrentWebview().label } });
}
