// mdx-utils — pure functions for MDX ↔ editor pipeline.
// Extracted for testability. No React, no DOM, no side effects.

// ---------------------------------------------------------------------------
// Import extraction / stripping
// ---------------------------------------------------------------------------

export interface MdxImport {
  name: string;
  appId: string;
}

/** Extract `import { Name } from '@apps/appId'` statements. */
export function extractImports(mdx: string): MdxImport[] {
  const imports: MdxImport[] = [];
  const re = /import\s*\{([^}]+)\}\s*from\s*['"]@apps\/([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(mdx)) !== null) {
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    const appId = m[2];
    for (const name of names) imports.push({ name, appId });
  }
  return imports;
}

/** Remove `import { ... } from '@apps/...'` lines from MDX source. */
export function stripAppImports(mdx: string): string {
  return mdx.replace(
    /^import\s*\{[^}]+\}\s*from\s*['"]@apps\/[^'"]+['"]\s*;?\s*$/gm,
    "",
  );
}

// ---------------------------------------------------------------------------
// Expression wrapping
// ---------------------------------------------------------------------------

/**
 * Wrap standalone flow expressions ({expr} on their own line) with <mdxexpr>
 * so they become clickable/editable via the components prop.
 * Uses lowercase tag name so MDX resolves it through _components.
 */
export function wrapExpressions(mdx: string): string {
  const lines = mdx.split("\n");
  let inCodeBlock = false;
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        return line;
      }
      if (inCodeBlock) return line;
      if (trimmed.startsWith("\\{")) return line;
      const match = trimmed.match(/^\{(.+)\}$/);
      if (match && !trimmed.startsWith("{/*")) {
        const expr = match[1];
        const encoded = JSON.stringify(expr);
        return `<mdxexpr source={${encoded}}>{${expr}}</mdxexpr>`;
      }
      return line;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Component JSX extraction
// ---------------------------------------------------------------------------

/** Extract all JSX usages of a named component, in source order. */
export function extractComponentJsx(mdx: string, name: string): string[] {
  const usages: { text: string; index: number }[] = [];
  // Self-closing: <Name ... />
  const re1 = new RegExp(`<${name}\\b[^>]*?\\/>`, "g");
  let m;
  while ((m = re1.exec(mdx)) !== null) {
    usages.push({ text: m[0], index: m.index });
  }
  // Opening+closing: <Name ...>...</Name>
  const re2 = new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}>`, "g");
  while ((m = re2.exec(mdx)) !== null) {
    if (!usages.some((u) => u.index === m!.index)) {
      usages.push({ text: m[0], index: m.index });
    }
  }
  usages.sort((a, b) => a.index - b.index);
  return usages.map((u) => u.text);
}

// ---------------------------------------------------------------------------
// Text patching
// ---------------------------------------------------------------------------

export interface PatchResult {
  patched: string;
  success: boolean;
}

/**
 * Replace the first occurrence of `oldFragment` in `source` with `newFragment`.
 * Returns the patched string and whether the patch was applied.
 */
export function patchSource(
  source: string,
  oldFragment: string,
  newFragment: string,
): PatchResult {
  const idx = source.indexOf(oldFragment);
  if (idx === -1) {
    return { patched: source, success: false };
  }
  const patched =
    source.slice(0, idx) + newFragment + source.slice(idx + oldFragment.length);
  return { patched, success: true };
}

// ---------------------------------------------------------------------------
// DOM → Markdown conversion
// ---------------------------------------------------------------------------

/**
 * Convert a simplified DOM-like structure to markdown.
 * This is the pure logic — the actual DOM version lives in MdxRenderer.
 * Here we define the tag→markdown mapping for testing.
 */
export const TAG_TO_MD: Record<string, (inner: string, attrs?: Record<string, string>) => string> = {
  strong: (inner) => `**${inner}**`,
  b: (inner) => `**${inner}**`,
  em: (inner) => `_${inner}_`,
  i: (inner) => `_${inner}_`,
  code: (inner) => `\`${inner}\``,
  del: (inner) => `~~${inner}~~`,
  s: (inner) => `~~${inner}~~`,
  a: (inner, attrs) => `[${inner}](${attrs?.href ?? ""})`,
  br: () => "\n",
};

// ---------------------------------------------------------------------------
// Resize wrapper detection / generation
// ---------------------------------------------------------------------------

export interface ResizeWrapper {
  width?: string;
  height?: string;
  componentJsx: string;
}

/**
 * Parse a `<div style={{width: "Xpx", height: "Ypx"}}><Component /></div>`
 * resize wrapper. Returns null if not a resize wrapper.
 */
export function parseResizeWrapper(jsx: string): ResizeWrapper | null {
  // Match <div style={{...}}>...<Component />...</div>
  const divMatch = jsx.match(
    /^<div\s+style=\{\{([^}]+)\}\}\s*>([\s\S]*)<\/div>$/,
  );
  if (!divMatch) return null;

  const styleStr = divMatch[1];
  const inner = divMatch[2].trim();

  // Inner must be a single self-closing JSX element
  if (!inner.match(/^<[A-Z][^>]*\/>$/)) return null;

  const width = styleStr.match(/width:\s*["']([^"']+)["']/)?.[1];
  const height = styleStr.match(/height:\s*["']([^"']+)["']/)?.[1];

  if (!width && !height) return null;

  return { width, height, componentJsx: inner };
}

/**
 * Generate a resize wrapper JSX string.
 * If no width/height, returns the component JSX as-is.
 */
export function generateResizeWrapper(
  componentJsx: string,
  width?: string,
  height?: string,
): string {
  if (!width && !height) return componentJsx;
  const parts: string[] = [];
  if (width) parts.push(`width: "${width}"`);
  if (height) parts.push(`height: "${height}"`);
  return `<div style={{${parts.join(", ")}}}>${componentJsx}</div>`;
}
