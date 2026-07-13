// Web Push opt-in checkbox for this device — extracted from the settings page
// so the notifications page can offer the exact same control (issue #237).
// State is the device's real subscription, asked from the service worker on
// mount; enabling/disabling reuses the one flow in notifications.ts.
//
// Callers gate on pushSupported() and a configured VAPID key — this component
// assumes both. `discover` mode (the notifications page) additionally renders
// nothing until the device is known to be un-subscribed: it's a discovery
// path for people who never open settings, so an already-subscribed device
// sees nothing. Once revealed it stays mounted, so enabling shows the
// now-checked state instead of the control vanishing mid-click.

import { useEffect, useState } from "react";
import { getPushSubscription, enablePush, disablePush } from "../notifications";
import { ErrorNote } from "./ui";

export function PushToggle({
  publicKey,
  discover = false,
  className,
}: {
  publicKey: string;
  discover?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // null = still asking the service worker whether this device is subscribed.
  const [pushOn, setPushOn] = useState<boolean | null>(null);
  const [revealed, setRevealed] = useState(!discover);

  useEffect(() => {
    let live = true;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void getPushSubscription().then((sub) => {
        if (live && current === generation) setPushOn(!!sub);
      });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };

    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    navigator.serviceWorker.addEventListener("controllerchange", refresh);

    // Chrome can change notification permission outside the page (Android app
    // settings, Safety Check, or WebAPK delegation). Refresh the subscription
    // when its Permissions API view changes so an already-open browser tab
    // cannot keep displaying a stale checked box.
    let permission: PermissionStatus | null = null;
    if ("permissions" in navigator) {
      void navigator.permissions
        .query({ name: "notifications" as PermissionName })
        .then((status) => {
          if (!live) return;
          permission = status;
          status.addEventListener("change", refresh);
        })
        .catch(() => {});
    }

    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      navigator.serviceWorker.removeEventListener("controllerchange", refresh);
      permission?.removeEventListener("change", refresh);
    };
  }, []);

  useEffect(() => {
    if (pushOn === false) setRevealed(true);
  }, [pushOn]);

  const toggle = async () => {
    if (pushOn == null) return;
    setBusy(true);
    setErr(null);
    try {
      if (pushOn) {
        await disablePush();
        setPushOn(false);
      } else {
        await enablePush(publicKey);
        setPushOn(true);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  if (!revealed) return null;

  const body = (
    <>
      <label className="settings-toggle">
        <input type="checkbox" checked={pushOn ?? false} disabled={busy || pushOn == null} onChange={toggle} />
        <span>
          Push notifications on this device
          <span className="settings-hint">Get a heads-up even when the app is closed.</span>
        </span>
      </label>
      {err && <ErrorNote message={err} />}
    </>
  );

  // The styled wrapper only exists once there's something inside it — a
  // `discover` caller's card must not paint as an empty box pre-reveal.
  return className ? <div className={className}>{body}</div> : body;
}
