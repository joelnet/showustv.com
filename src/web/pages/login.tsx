import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../app";
import { isStandalone } from "../pwa";
import { AuthCard } from "../components/auth-card";

export function Login() {
  const { user } = useAuth();
  const navigate = useNavigate();
  // The landing page links to /login?mode=register for its sign-up CTAs.
  const [params] = useSearchParams();

  if (user) {
    navigate("/", { replace: true });
    return null;
  }

  return (
    <div className="login-page">
      {/* Installed (standalone) users have no marketing landing page to
          return to — "/" renders Login itself — so drop the dead escape
          hatch there and keep it for browser visitors (issue #46). */}
      <AuthCard
        initialMode={params.get("mode") === "register" ? "register" : "login"}
        close={!isStandalone()}
      />
    </div>
  );
}
