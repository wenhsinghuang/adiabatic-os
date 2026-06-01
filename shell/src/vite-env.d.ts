/// <reference types="vite/client" />

declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}

interface Window {
  adiabaticHost?: {
    getCoreToken(): Promise<string>;
    getBridgeToken(): Promise<string>;
    getWorkspacePath(): Promise<string>;
    chooseWorkspacePath(): Promise<{ path: string | null }>;
    setWorkspacePath(path: string): Promise<{ path: string }>;
    createTerminal(): Promise<{ id: string }>;
    writeTerminal(id: string, data: string): void;
    resizeTerminal(id: string, cols: number, rows: number): void;
    disposeTerminal(id: string): Promise<{ ok: true }>;
    onTerminalData(callback: (payload: { id: string; data: string }) => void): () => void;
    onTerminalExit(callback: (payload: { id: string; code: number | null }) => void): () => void;
  };
}
