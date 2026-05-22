import { useUISettings } from "../stores/uiSettings";

/**
 * Appearance settings: toggles for app-shell visual treatment.
 *
 * Colorful mode: sage-green palette borrowed from the Stash desktop
 * app — pale sage sidebar tint and a sage capture button in light
 * mode; mirrored deep green-tinged surface + the same vivid sage
 * button in dark mode. Default-off; persisted via the workspace
 * settings table so it survives restarts and follows the workspace.
 */
export function AppearanceTab() {
  const colorful = useUISettings((s) => s.colorful);
  const setColorful = useUISettings((s) => s.setColorful);
  const compact = useUISettings((s) => s.compact);
  const setCompact = useUISettings((s) => s.setCompact);

  return (
    <div className="space-y-6">
      <section>
        <h3 className="font-medium mb-2">Theme</h3>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={colorful}
            onChange={(e) => void setColorful(e.target.checked)}
            className="mt-0.5 cursor-pointer"
          />
          <div className="flex-1">
            <div className="text-sm font-medium">Colorful mode</div>
            <div className="text-xs text-neutral-500 mt-0.5">
              Deep sage sidebar with white text, sage-green tag and
              selection highlights — palette borrowed from the Stash
              desktop app.
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span
                className="inline-block w-5 h-5 rounded-md"
                style={{ background: "#557153" }}
                title="Sidebar"
              />
              <span
                className="inline-block w-5 h-5 rounded-full"
                style={{ background: "#87a970" }}
                title="Accent / send button"
              />
              <span
                className="inline-block w-5 h-5 rounded-md"
                style={{ background: "#dde6d2" }}
                title="Tag chip (light)"
              />
              <span
                className="inline-block w-5 h-5 rounded-md"
                style={{ background: "#3f573d" }}
                title="Deep accent (dark)"
              />
            </div>
          </div>
        </label>
      </section>

      <section>
        <h3 className="font-medium mb-2">Density</h3>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={compact}
            onChange={(e) => void setCompact(e.target.checked)}
            className="mt-0.5 cursor-pointer"
          />
          <div className="flex-1">
            <div className="text-sm font-medium">Compact spacing</div>
            <div className="text-xs text-neutral-500 mt-0.5">
              Trim padding inside each card and tighten the gap between
              cards so more blocks fit on screen.
            </div>
          </div>
        </label>
      </section>
    </div>
  );
}
