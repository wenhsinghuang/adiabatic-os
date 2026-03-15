// Editor operations — behavioral contract for the Obsidian-style MDX editor.
// Pure functions: MDX string in → MDX string out. No React, no DOM.

/** Split MDX source into blocks as the user sees them in view mode.
 *  Splits on blank lines, but keeps multi-line HTML/JSX elements intact
 *  even when they contain internal blank lines (e.g. <details>...\n\n...</details>).
 */
export function getBlocks(mdx: string): string[] {
  const raw = mdx.split(/\n\n+/).filter((s) => s.length > 0);
  const result: string[] = [];
  let acc = "";

  for (const chunk of raw) {
    acc = acc ? acc + "\n\n" + chunk : chunk;
    if (htmlTagsBalanced(acc)) {
      result.push(acc);
      acc = "";
    }
  }
  if (acc) result.push(acc);
  return result;
}

/** Check whether all HTML/JSX tags in text are properly closed. */
function htmlTagsBalanced(text: string): boolean {
  let depth = 0;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    // Skip fenced code blocks
    if (ch === "`" && text.slice(i, i + 3) === "```") {
      const end = text.indexOf("```", i + 3);
      i = end !== -1 ? end + 3 : len;
      continue;
    }

    // Skip inline code
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      i = end !== -1 ? end + 1 : len;
      continue;
    }

    if (ch === "<") {
      if (i + 1 < len && text[i + 1] === "/") {
        // Closing tag </name>
        const m = text.slice(i).match(/^<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/);
        if (m) {
          depth--;
          i += m[0].length;
          continue;
        }
      } else if (i + 1 < len && /[a-zA-Z]/.test(text[i + 1])) {
        // Opening or self-closing tag — scan to find closing >
        // handling JSX {} expressions and string literals inside attributes
        const nameM = text.slice(i).match(/^<([a-zA-Z][a-zA-Z0-9]*)/);
        if (nameM) {
          let j = i + nameM[0].length;
          let braceDepth = 0;
          let strChar: string | null = null;
          let tagEnd = -1;

          while (j < len) {
            const c = text[j];
            if (strChar) {
              if (c === strChar && text[j - 1] !== "\\") strChar = null;
            } else if (c === '"' || c === "'") {
              strChar = c;
            } else if (c === "{") {
              braceDepth++;
            } else if (c === "}") {
              braceDepth--;
            } else if (braceDepth === 0 && c === ">") {
              tagEnd = j;
              break;
            }
            j++;
          }

          if (tagEnd !== -1) {
            // Self-closing? Check if char before > (skipping spaces) is /
            let k = tagEnd - 1;
            while (k > i && text[k] === " ") k--;
            if (text[k] !== "/") {
              depth++;
            }
            i = tagEnd + 1;
            continue;
          }
        }
      }
    }

    i++;
  }

  return depth <= 0;
}

/** Replace the block at `blockIndex` with `newContent`, return new MDX. */
export function replaceBlock(
  mdx: string,
  blockIndex: number,
  newContent: string,
): string {
  const blocks = getBlocks(mdx);
  if (blockIndex < 0 || blockIndex >= blocks.length) return mdx;

  const oldBlock = blocks[blockIndex];

  // Walk through prior blocks to find the exact position in source
  let searchFrom = 0;
  for (let i = 0; i < blockIndex; i++) {
    const pos = mdx.indexOf(blocks[i], searchFrom);
    searchFrom = pos + blocks[i].length;
  }

  const pos = mdx.indexOf(oldBlock, searchFrom);
  if (pos === -1) return mdx;

  return mdx.slice(0, pos) + newContent + mdx.slice(pos + oldBlock.length);
}

/** Edit a component's JSX (for popover save). */
export function editComponentJsx(
  mdx: string,
  oldJsx: string,
  newJsx: string,
): string {
  const idx = mdx.indexOf(oldJsx);
  if (idx === -1) return mdx;
  return mdx.slice(0, idx) + newJsx + mdx.slice(idx + oldJsx.length);
}

/** Delete a component from the MDX source. */
export function deleteComponent(mdx: string, componentJsx: string): string {
  const blocks = getBlocks(mdx);
  const filtered = blocks.filter((b) => {
    if (b === componentJsx) return false;
    if (b.includes(componentJsx) && /^<div\s+style=/.test(b)) return false;
    return true;
  });
  return filtered.join("\n\n");
}

/** Move a component to a new block position (DnD). */
export function moveComponent(
  mdx: string,
  componentJsx: string,
  toBlockIndex: number,
): string {
  const blocks = getBlocks(mdx);
  const fromIdx = blocks.findIndex(
    (b) =>
      b === componentJsx ||
      (b.includes(componentJsx) && /^<div\s+style=/.test(b)),
  );
  if (fromIdx === -1) return mdx;

  const block = blocks[fromIdx];
  blocks.splice(fromIdx, 1);
  const adjustedIdx =
    toBlockIndex > fromIdx ? toBlockIndex - 1 : toBlockIndex;
  blocks.splice(adjustedIdx, 0, block);
  return blocks.join("\n\n");
}

/** Resize a component — wrap/update/remove div style wrapper. */
export function resizeComponent(
  mdx: string,
  componentJsx: string,
  width?: string,
  height?: string,
): string {
  const blocks = getBlocks(mdx);
  const newBlocks = blocks.map((block) => {
    if (!block.includes(componentJsx)) return block;

    // Check if this block is a size wrapper that wraps EXACTLY this component
    const isWrapper =
      /^<div\s+style=\{\{/.test(block) && block.endsWith("</div>");

    if (isWrapper) {
      const openTagEnd = block.indexOf(">") + 1;
      const closeTagStart = block.lastIndexOf("</div>");
      const inner = block.slice(openTagEnd, closeTagStart).trim();

      if (inner === componentJsx) {
        // Existing size wrapper for this exact component
        if (!width && !height) return componentJsx; // unwrap
        return wrapWithSize(componentJsx, width, height);
      }
      // Block is a different container (flex, etc.) — don't touch
      return block;
    }

    // Component is a standalone block
    if (block === componentJsx && (width || height)) {
      return wrapWithSize(componentJsx, width, height);
    }

    return block;
  });
  return newBlocks.join("\n\n");
}

function wrapWithSize(jsx: string, width?: string, height?: string): string {
  const parts: string[] = [];
  if (width) parts.push(`width: "${width}"`);
  if (height) parts.push(`height: "${height}"`);
  return `<div style={{${parts.join(", ")}}}>${jsx}</div>`;
}

/** Insert a new component at a block position (slash command). */
export function insertComponent(
  mdx: string,
  componentJsx: string,
  atBlockIndex: number,
): string {
  const blocks = getBlocks(mdx);
  blocks.splice(atBlockIndex, 0, componentJsx);
  return blocks.join("\n\n");
}

/** Ensure a component import exists; add or merge if needed. */
export function ensureImport(
  mdx: string,
  componentName: string,
  appId: string,
): string {
  // Already imported?
  const importRe = new RegExp(
    `import\\s*\\{[^}]*\\b${componentName}\\b[^}]*\\}\\s*from\\s*['"]@apps/${appId}['"]`,
  );
  if (importRe.test(mdx)) return mdx;

  // Existing import from same app? Merge.
  const appImportRe = new RegExp(
    `(import\\s*\\{)([^}]*)(\\}\\s*from\\s*['"]@apps/${appId}['"])`,
  );
  const match = appImportRe.exec(mdx);
  if (match) {
    const names = match[2].trim();
    return mdx.replace(appImportRe, `$1 ${names}, ${componentName} $3`);
  }

  // Add new import line at the top
  const importLine = `import { ${componentName} } from "@apps/${appId}"`;
  if (!mdx.trim()) return importLine;

  const blocks = getBlocks(mdx);
  const lastImportIdx = blocks.reduce(
    (acc, b, i) => (/^import\s/.test(b.trim()) ? i : acc),
    -1,
  );
  if (lastImportIdx >= 0) {
    // After existing imports
    blocks.splice(lastImportIdx + 1, 0, importLine);
    return blocks.join("\n\n");
  }
  return importLine + "\n\n" + mdx;
}
