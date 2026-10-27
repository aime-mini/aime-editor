/**
 * A short, stable fingerprint of a text (FNV-1a, 32-bit), for telling "the
 * same text as before" from "a different one" without keeping the text.
 * Not a secure hash: two different texts can share one, which is acceptable
 * where a false "same" costs only a repeat.
 */
export function fingerprint(text: string): string {
  const FNV_OFFSET = 0x811c9dc5;
  const FNV_PRIME = 0x01000193;
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
