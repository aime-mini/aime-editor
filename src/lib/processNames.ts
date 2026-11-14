/** A process, as far as naming it goes. */
interface Named {
  name: string;
}

/**
 * Processes as a person would list them: each name once, in the order first
 * seen, with a count where several share it - a test runner is often three
 * `node` processes, and saying `node` three times says nothing more.
 */
export function processNames(processes: readonly Named[]): string {
  const counts = new Map<string, number>();
  for (const { name } of processes) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => (count === 1 ? name : `${name} ×${String(count)}`)).join(", ");
}
