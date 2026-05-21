import { useState } from "react";
import { X, FolderOpen, Database, Palette } from "lucide-react";
import { WorkspaceTab } from "./WorkspaceTab";
import { BackupsTab } from "./BackupsTab";
import { AppearanceTab } from "./AppearanceTab";

type Tab = "workspace" | "appearance" | "backups";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("workspace");

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-neutral-900 rounded-lg w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
          <h2 className="font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-1 min-h-0">
          <nav className="w-44 border-r border-neutral-200 dark:border-neutral-800 p-2 text-sm">
            <NavItem
              active={tab === "workspace"}
              onClick={() => setTab("workspace")}
              icon={<FolderOpen size={14} />}
              label="Workspace"
            />
            <NavItem
              active={tab === "appearance"}
              onClick={() => setTab("appearance")}
              icon={<Palette size={14} />}
              label="Appearance"
            />
            <NavItem
              active={tab === "backups"}
              onClick={() => setTab("backups")}
              icon={<Database size={14} />}
              label="Backups"
            />
          </nav>
          <div className="flex-1 overflow-y-auto p-4">
            {tab === "workspace" && <WorkspaceTab />}
            {tab === "appearance" && <AppearanceTab />}
            {tab === "backups" && <BackupsTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

function NavItem({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded ${
        active
          ? "bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
          : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
