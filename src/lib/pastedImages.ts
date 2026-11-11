import { invoke } from "@tauri-apps/api/core";

/**
 * The picture formats a clipboard can hand over, by the extension each is
 * saved under. A screenshot copied from a snipping tool arrives as `image/png`.
 */
const EXTENSION_OF: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

/** The pictures in a paste; empty when what was pasted is text. */
export function pastedImages(data: DataTransfer): File[] {
  return [...data.files].filter((file) => file.type in EXTENSION_OF);
}

/**
 * Saves a pasted picture into the project (`pasted.rs`) and returns the path
 * the AI is given. The bytes travel as the raw body of the call.
 */
export async function savePastedImage(root: string, image: File): Promise<string> {
  const bytes = new Uint8Array(await image.arrayBuffer());
  return invoke<string>("save_pasted_image", bytes, {
    headers: {
      "x-aime-root": encodeURIComponent(root),
      "x-aime-extension": EXTENSION_OF[image.type] ?? "png",
    },
  });
}
