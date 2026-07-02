import { createRoot } from "react-dom/client";
import { App } from "./app";
import { initPwa } from "./pwa";
import "./styles.css";

// Before render: beforeinstallprompt can fire before React mounts.
initPwa();

createRoot(document.getElementById("root")!).render(<App />);
