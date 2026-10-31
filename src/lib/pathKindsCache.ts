/** What a path names on disk (`fs_cmds::PathKind`). */
export type PathKind = "file" | "dir";

/** Asks the disk about several paths at once; one answer per path, null for a missing one. */
export type AskDisk = (paths: string[]) => Promise<(PathKind | null)[]>;

interface Watcher {
  paths: readonly string[];
  /** Called when one of `paths` now names something else than before. */
  changed: () => void;
}

/**
 * What the disk said about the paths the conversation mentions, shared by every
 * message on screen.
 *
 * A conversation is hundreds of messages, each naming paths. Asked one message
 * at a time, every change on disk would send one request per message for the
 * same missing paths, and re-render every message to do it. Here the messages
 * register what they name; the questions of one moment go out as one request;
 * a path that was missing is asked again only once the disk has changed since
 * (`recheck`) - an answer often names a file in the same breath as the AI
 * writes it; and only a message whose path came back different is told.
 */
export class PathKindsCache {
  private readonly known = new Map<string, { kind: PathKind | null; version: number }>();
  private readonly asking = new Set<string>();
  private readonly waiting = new Set<string>();
  private readonly watchers = new Set<Watcher>();
  private version = 0;
  private flushScheduled = false;

  constructor(private readonly askDisk: AskDisk) {}

  /** The kind the disk last gave `path`, if it exists. */
  kindOf(path: string): PathKind | undefined {
    return this.known.get(path)?.kind ?? undefined;
  }

  /** Follows `paths` until the returned function is called; `changed` hears of a different answer. */
  watch(paths: readonly string[], changed: () => void): () => void {
    const watcher: Watcher = { paths, changed };
    this.watchers.add(watcher);
    this.request(paths);
    return () => {
      this.watchers.delete(watcher);
    };
  }

  /** The disk changed: paths that were missing may be there now. */
  recheck(version: number): void {
    this.version = version;
    for (const watcher of this.watchers) this.request(watcher.paths);
  }

  private request(paths: readonly string[]): void {
    for (const path of paths) {
      if (!this.asking.has(path) && this.needsAsking(path)) this.waiting.add(path);
    }
    if (this.waiting.size === 0 || this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flush();
    });
  }

  private needsAsking(path: string): boolean {
    const answer = this.known.get(path);
    return answer === undefined || (answer.kind === null && answer.version !== this.version);
  }

  private flush(): void {
    this.flushScheduled = false;
    const paths = [...this.waiting];
    this.waiting.clear();
    if (paths.length === 0) return;
    const version = this.version;
    for (const path of paths) this.asking.add(path);
    this.askDisk(paths)
      .then((kinds) => {
        const differs = new Set<string>();
        paths.forEach((path, index) => {
          const kind = kinds[index] ?? null;
          if ((this.known.get(path)?.kind ?? null) !== kind) differs.add(path);
          this.known.set(path, { kind, version });
        });
        if (differs.size === 0) return;
        for (const watcher of this.watchers) {
          if (watcher.paths.some((path) => differs.has(path))) watcher.changed();
        }
      })
      .catch((error: unknown) => {
        console.error("could not ask the disk about the paths an answer mentions:", error);
      })
      .finally(() => {
        for (const path of paths) this.asking.delete(path);
      });
  }
}
