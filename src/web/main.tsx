import { createRoot } from "react-dom/client";
import { App } from "./app";
import { initPwa } from "./pwa";
import { initOffline } from "./offline";
import "./styles.css";

// Before render: beforeinstallprompt can fire before React mounts.
initPwa();
// Connectivity tracking + replay of mutations queued in a previous session.
initOffline();

createRoot(document.getElementById("root")!).render(<App />);
