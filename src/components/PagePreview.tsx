import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../i18n";
import { fingerprint } from "../lib/fingerprint";
import { pageAddress, pageOrigin, previewRootOf } from "../lib/pagePreview";
import { useWorkspace } from "../stores/workspace";

/**
 * What the page's scripts may do. Everything a page needs to work as one -
 * run, submit a form, open an alert - and not `allow-same-origin`: the page
 * runs in an origin of its own, with no way to reach the app around it (no
 * Tauri IPC, no reading Aime's storage), and without `allow-top-navigation`
 * a link cannot take the window away from the editor.
 */
const SANDBOX = "allow-scripts allow-forms allow-modals";

/** The page's address, or why there is none - for one file. */
type Preview = { path: string; url: string } | { path: string; problem: string };

/**
 * An .html file as the page it is.
 *
 * Served by Rust from the workspace (`page_preview.rs`) rather than handed to
 * the frame as text, so the stylesheets, scripts and pictures the page names
 * by relative address come with it. It shows the file as saved and loads again
 * on every save - with auto save on, a second after typing stops.
 */
export function PagePreview({ path }: { path: string }) {
  const rootPath = useWorkspace((s) => s.rootPath);
  const savedContent = useWorkspace((s) => s.savedContent);
  const [preview, setPreview] = useState<Preview | null>(null);
  const t = useT();

  useEffect(() => {
    const root = previewRootOf(path, rootPath);
    let stale = false;
    invoke<string>("page_preview_root", { root })
      .then((token) => {
        if (!stale) setPreview({ path, url: pageAddress(pageOrigin(), token, root, path) });
      })
      .catch((error: unknown) => {
        if (!stale) setPreview({ path, problem: String(error) });
      });
    return () => {
      stale = true;
    };
  }, [path, rootPath]);

  // A new frame per saved version: the page starts over as a browser reload would.
  const version = useMemo(() => fingerprint(savedContent), [savedContent]);

  if (preview?.path !== path) return null;
  if ("problem" in preview) {
    return <p className="p-4 text-[12px] text-danger">{t("file.pageFailed", { reason: preview.problem })}</p>;
  }
  return (
    <iframe
      key={version}
      src={preview.url}
      sandbox={SANDBOX}
      title={t("file.pageTitle", { name: path.split(/[\\/]/).pop() ?? path })}
      // A page that sets no background expects a browser's white, not the editor's theme.
      className="h-full w-full border-0 bg-white"
    />
  );
}
