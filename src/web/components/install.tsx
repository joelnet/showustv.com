// "Install App" affordance: hidden until the browser says the app is
// installable. On Chromium it triggers the one-tap install prompt; on iOS
// (no programmatic install) it links to the /install walkthrough page.
// Renders nothing when unavailable — callers can gate wrappers on
// useInstallPrompt().
import { Link } from "react-router-dom";
import { useInstallPrompt } from "../pwa";

export function InstallAppButton({ buttonClass = "btn" }: { buttonClass?: string }) {
  const { available, ios, install } = useInstallPrompt();

  if (!available) return null;

  if (ios) {
    return (
      <div className="install-app">
        <Link to="/install" className={buttonClass}>
          Install App
        </Link>
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
