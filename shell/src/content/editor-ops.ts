// Editor operations — behavioral contract for the Obsidian-style MDX editor.
// Pure functions: MDX string in → MDX string out. No React, no DOM.

/** Split MDX source into blocks as the user sees them in view mode. */
export function getBlocks(mdx: string): string[] {
  return mdx.split(/\n\n+/).filter((s) => s.length > 0);
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

    const isWrapper =
      /^<div\s+style=\{\{/.test(block) && block.endsWith("</div>");

    if (isWrapper) {
      if (!width && !height) return componentJsx;
      return wrapWithSize(componentJsx, width, height);
    }

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
