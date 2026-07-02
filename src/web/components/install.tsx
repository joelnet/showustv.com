// "Install App" affordance (same behavior as open.raweditor.io's install
// section): hidden until the browser says the app is installable; on iOS the
// button reveals manual Add-to-Home-Screen instructions instead. Renders
// nothing when unavailable — callers can gate wrappers on useInstallPrompt().
import { useState } from "react";
import { useInstallPrompt } from "../pwa";

export function InstallAppButton({ buttonClass = "btn" }: { buttonClass?: string }) {
  const { available, ios, install } = useInstallPrompt();
  const [showHint, setShowHint] = useState(false);

  if (!available) return null;

  if (ios) {
    return (
      <div className="install-app">
        <button type="button" className={buttonClass} onClick={() => setShowHint((v) => !v)}>
          Add to Home Screen
        </button>
        {showHint && (
          <p className="install-hint">In Safari: tap the Share button, then &ldquo;Add to Home Screen&rdquo;.</p>
        )}
      </div>
    );
  }

  return (
    <div className="install-app">
      <button type="button" className={buttonClass} onClick={install}>
        Install App
      </button>
    </div>
  );
}
