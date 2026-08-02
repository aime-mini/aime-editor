import { Files, GitBranch } from "lucide-react";
import { useT } from "../i18n";
import { useLayout, type SidebarView } from "../stores/layout";
import { FileTree } from "./FileTree";
import { GitPanel } from "./GitPanel";

/** Left sidebar: Explorer / Git views behind a compact tab strip. */
export function Sidebar() {
  const { sidebarView, setSidebarView } = useLayout();
  const t = useT();

  const tab = (view: SidebarView, icon: React.ReactNode, title: string) => (
    <button
      onClick={() => {
        setSidebarView(view);
      }}
      title={title}
      className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 py-1.5 text-[11px] ${
        sidebarView === view ? "border-accent text-accent" : "border-transparent text-muted hover:text-fg"
      }`}
    >
      {icon}
    </button>
  );

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex border-b border-line">
        {tab("files", <Files size={14} />, t("sidebar.files"))}
        {tab("git", <GitBranch size={14} />, t("sidebar.git"))}
      </div>
      <div className="min-h-0 flex-1">{sidebarView === "files" ? <FileTree /> : <GitPanel />}</div>
    </div>
  );
}
