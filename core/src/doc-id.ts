import { isAbsolute, relative, resolve } from "path";

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function validateDocId(id: string): void {
  if (!id || id.trim() !== id) {
    throw new Error("Invalid doc id");
  }
  if (isAbsolute(id) || id.startsWith("/") || id.includes("\\") || CONTROL_CHARS.test(id)) {
    throw new Error("Invalid doc id");
  }

  const parts = id.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Invalid doc id");
  }
}

export function resolveDocFilePath(pagesDir: string, docId: string): string {
  validateDocId(docId);

  const root = resolve(pagesDir);
  const target = resolve(root, `${docId}.mdx`);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Invalid doc id");
  }
  return target;
}
