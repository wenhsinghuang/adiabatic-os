// Editor operations — behavioral contract for the Obsidian-style MDX editor.
// Pure functions: MDX string in → MDX string out. No React, no DOM.

/** Split MDX source into blocks as the user sees them in view mode. */
export function getBlocks(_mdx: string): string[] {
  throw new Error("not implemented");
}

/** Replace the block at `blockIndex` with `newContent`, return new MDX. */
export function replaceBlock(
  _mdx: string,
  _blockIndex: number,
  _newContent: string,
): string {
  throw new Error("not implemented");
}

/** Edit a component's JSX (for popover save). */
export function editComponentJsx(
  _mdx: string,
  _oldJsx: string,
  _newJsx: string,
): string {
  throw new Error("not implemented");
}

/** Delete a component from the MDX source. */
export function deleteComponent(_mdx: string, _componentJsx: string): string {
  throw new Error("not implemented");
}

/** Move a component to a new block position (DnD). */
export function moveComponent(
  _mdx: string,
  _componentJsx: string,
  _toBlockIndex: number,
): string {
  throw new Error("not implemented");
}

/** Resize a component — wrap/update/remove div style wrapper. */
export function resizeComponent(
  _mdx: string,
  _componentJsx: string,
  _width?: string,
  _height?: string,
): string {
  throw new Error("not implemented");
}

/** Insert a new component at a block position (slash command). */
export function insertComponent(
  _mdx: string,
  _componentJsx: string,
  _atBlockIndex: number,
): string {
  throw new Error("not implemented");
}
