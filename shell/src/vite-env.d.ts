/// <reference types="vite/client" />

declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}

interface Window {
  adiabaticHost?: {
    getWorkspacePath(): Promise<string>;
    chooseWorkspacePath(): Promise<{ path: string | null }>;
    setWorkspacePath(path: string): Promise<{ path: string }>;
  };
}
