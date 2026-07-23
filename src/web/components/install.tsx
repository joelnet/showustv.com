// "Install App" affordance: hidden until the browser says the app is
// installable. On Chromium it triggers the one-tap install prompt; on iOS
// (no programmatic install) it links to the /install walkthrough page.
// Renders nothing when unavailable — callers can gate wrappers on
// useInstallPrompt(). Mirrors the signed-in app header's install button
// (download icon + label) so the landing header matches it.
import { Link } from "react-router-dom";
import { useInstallPrompt } from "../pwa";
import { IconDownload } from "./icons";

export function InstallAppButton({ buttonClass = "btn" }: { buttonClass?: string }) {
  const { available, ios, install } = useInstallPrompt();

  if (!available) return null;

  const label = (
    <>
      <IconDownload size={14} /> <span>Install App</span>
    </>
  );

  // No aria-label: the visible "Install App" text is the accessible name, so it
  // matches what voice-control users say (WCAG 2.5.3 Label in Name).
  if (ios) {
    return (
      <Link to="/install" className={buttonClass}>
        {label}
      </Link>
    );
  }

  return (
    <button type="button" className={buttonClass} onClick={install}>
      {label}
    </button>
  );
}
