import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// Dev-only host shim: in the browser (vite dev) there is no Electron preload,
// so stand in for window.adiabaticHost and point the shell at a standalone
// core. URL/tokens come from VITE_ env vars with localhost dev defaults.
// Electron and production builds provide the real host and skip this branch.
if (import.meta.env.DEV && !window.adiabaticHost) {
  const base = import.meta.env.VITE_ADIABATIC_CORE_URL ?? "http://localhost:3000";
  const coreToken = import.meta.env.VITE_ADIABATIC_CORE_TOKEN ?? "devtoken";
  const bridgeToken = import.meta.env.VITE_ADIABATIC_BRIDGE_TOKEN ?? "devbridge";
  window.adiabaticHost = {
    getCoreToken: async () => coreToken,
    getBridgeToken: async () => bridgeToken,
    getRecoveryCode: async () => "",
    importRecoveryCode: async () => ({ coreBaseUrl: base }),
    getCoreBaseUrl: async () => base,
    getCoreStartError: async () => null,
    retryCore: async () => ({ coreBaseUrl: base }),
    rotateCorePort: async () => ({ coreBaseUrl: base }),
    openExternal: async (url: string) => {
      window.open(url, "_blank", "noopener");
    },
    getWorkspacePath: async () => "",
    chooseWorkspacePath: async () => ({ path: null }),
    setWorkspacePath: async (path: string) => ({ path }),
    createTerminal: async () => {
      throw new Error("adiabaticHost.createTerminal is unavailable in browser dev");
    },
    writeTerminal: () => {},
    resizeTerminal: () => {},
    disposeTerminal: async () => ({ ok: true as const }),
    onTerminalData: () => () => {},
    onTerminalExit: () => () => {},
  };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
