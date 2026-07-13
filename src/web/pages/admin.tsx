// Admin page (issue #275): site-wide admin tools that aren't tied to one
// profile (those live in AdminTools on profile pages, issue #17). Linked from
// Settings for admins only. The render gate below is UX, not security — a
// non-admin who types /admin just lands back home; every /api/admin endpoint
// re-checks users.is_admin server-side (routes/admin.ts) and answers an
// indistinguishable 404 to anyone else.
import { useState } from "react";
import { Navigate } from "react-router-dom";
import { post } from "../api";
import { useAuth } from "../app";
import { useToast } from "../components/toast";
import { refreshUnread } from "../notifications";

export function AdminPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  if (!user?.isAdmin) return <Navigate to="/" replace />;

  const sendTest = async () => {
    setBusy(true);
    try {
      await post("/admin/test-notification");
      // The new row is unread by definition — refresh the bell badge now
      // instead of waiting for its next poll, so the test shows instantly.
      void refreshUnread();
      toast("Test notification sent");
    } catch {
      toast("Couldn't send the test notification", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings">
      <h1 className="page-title">Admin</h1>

      <h2 className="settings-subtitle">Notifications</h2>
      <p className="settings-hint">
        Sends yourself a test notification. It lands behind the bell, and pushes to any of your devices that have
        push notifications turned on.
      </p>
      <button className="btn" onClick={sendTest} disabled={busy}>
        {busy ? "Sending…" : "Send test notification"}
      </button>
    </div>
  );
}
