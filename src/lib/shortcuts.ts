/**
 * Keyboard shortcuts as each platform has them: the command key on a Mac,
 * Ctrl on Windows and Linux - in what is pressed and in how it is written.
 */

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Whether the platform's own modifier is held: ⌘ on a Mac, Ctrl elsewhere. */
export function withModifier(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">): boolean {
  return IS_MAC ? event.metaKey : event.ctrlKey;
}

/** A shortcut as this platform writes it: "Ctrl+D", or "⌘D" on a Mac. */
export function shortcutLabel(key: string, options: { shift?: boolean } = {}): string {
  if (IS_MAC) return `${options.shift === true ? "⇧" : ""}⌘${key}`;
  return `Ctrl+${options.shift === true ? "Shift+" : ""}${key}`;
}

/** Whether a key press belongs to a field being typed in, which keeps its own shortcuts. */
export function typingInField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}
