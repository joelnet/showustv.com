// Native share affordance (issue #147). Where the browser offers the Web
// Share API (mobile / installed PWA) the button opens the native share
// sheet; elsewhere it copies the link with a brief confirmation. Surfaces
// that already sit a "Copy link" button next to it pass fallback="hide" so
// unsupported browsers keep the single copy affordance instead of two.
import { useState } from "react";
import { IconShare, IconCheck } from "./icons";

const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

export function ShareButton({
  title,
  text,
  path,
  variant = "button",
  fallback = "copy",
}: {
  title: string;
  text?: string;
  path: string; // app-relative route; shared as an absolute URL
  variant?: "button" | "link" | "icon";
  fallback?: "copy" | "hide";
}) {
  const [copied, setCopied] = useState(false);
  if (!canNativeShare && fallback === "hide") return null;

  const share = async () => {
    const url = `${window.location.origin}${path}`;
    if (canNativeShare) {
      try {
        await navigator.share({ title, text, url });
        return;
      } catch (e) {
        // Dismissing the share sheet rejects with AbortError — a cancel,
        // not an error. Anything else (rare) falls through to the copy path.
        if (e instanceof DOMException && e.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable too — nothing sensible left to do.
    }
  };

  const hint = canNativeShare ? "Share" : "Copy link to share";

  // Bare glyph, no text (issue #241) — the profile header slots this right
  // beside the username. Copy feedback swaps the glyph to a check since
  // there's no label to flip to "Copied".
  if (variant === "icon") {
    return (
      <button
        type="button"
        className="icon-btn"
        onClick={share}
        aria-label={copied ? "Link copied" : hint}
        title={copied ? "Copied ✓" : hint}
      >
        {copied ? <IconCheck size={15} /> : <IconShare size={15} />}
      </button>
    );
  }

  return (
    <button
      type="button"
      className={variant === "link" ? "link-btn" : "btn btn-ghost"}
      onClick={share}
      title={hint}
    >
      <IconShare size={variant === "link" ? 13 : 15} /> {copied ? "Copied ✓" : "Share"}
    </button>
  );
}
