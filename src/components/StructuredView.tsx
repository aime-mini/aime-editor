import { useMemo } from "react";
import { TriangleAlert } from "lucide-react";
import { useT } from "../i18n";
import { jsonStructure, xmlStructure } from "../lib/structured";
import { PropertyTable } from "./CloudDetail";

/**
 * A JSON or XML file as a folded tree - the property table the cloud panel
 * draws a resource's configuration in, pointed at a file. A file that does not
 * parse says so in the parser's own words and leaves the text view to show
 * where; this view never guesses at a broken file.
 */
export function StructuredView({ text, kind }: { text: string; kind: "json" | "xml" }) {
  const t = useT();
  const structure = useMemo(() => (kind === "json" ? jsonStructure(text) : xmlStructure(text)), [text, kind]);

  if (structure.kind === "invalid") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[12px]">
        <TriangleAlert size={24} className="text-danger" />
        <p className="font-medium">{t(kind === "json" ? "file.jsonInvalid" : "file.xmlInvalid")}</p>
        <code className="max-w-2xl text-[11px] text-muted">{structure.reason}</code>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col text-[12px]">
      <div className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-muted">
        <span className="tabular-nums">{t("file.propertyCount", { count: structure.count })}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <PropertyTable rows={structure.rows} />
      </div>
    </div>
  );
}
