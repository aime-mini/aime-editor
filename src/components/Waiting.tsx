import { Loader2 } from "lucide-react";

/**
 * One line saying that something is on its way.
 *
 * It stands where the content will be, so an answer that takes a second reads as
 * work in progress rather than as an empty panel - the difference between "there
 * is nothing here" and "we are still looking".
 */
export function Waiting({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-1.5 text-[12px] text-muted">
      <Loader2 size={12} className="animate-spin" /> {label}
    </p>
  );
}
