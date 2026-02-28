// MDX ↔ BlockNote serialization
//
// mdxToBlocks: MDX string → BlockNote blocks (for loading into view mode)
// blocksToMdx: BlockNote blocks → MDX string (for saving)
//
// Strategy:
//   1. Parse MDX into segments (text + component references)
//   2. Text segments → use BlockNote's markdown parser
//   3. Component segments → AppBlock instances
//   4. Reverse: iterate blocks, text → markdown, AppBlock → component tag

import type { BlockNoteEditor } from "@blocknote/core";
import { parseMDX, serializeComponent, type ComponentSegment } from "../renderer/mdx-parser";
import type { AdiabaticSchema } from "./schema";

type Editor = BlockNoteEditor<AdiabaticSchema>;
type Block = Awaited<ReturnType<Editor["tryParseMarkdownToBlocks"]>>[number];

// MDX → BlockNote blocks
export async function mdxToBlocks(editor: Editor, mdx: string): Promise<Block[]> {
  const segments = parseMDX(mdx);
  const allBlocks: Block[] = [];

  for (const seg of segments) {
    if (seg.type === "markdown") {
      const blocks = await editor.tryParseMarkdownToBlocks(seg.content);
      allBlocks.push(...blocks);
    } else {
      // Component segment → AppBlock
      allBlocks.push({
        type: "appComponent",
        props: {
          componentName: seg.name,
          componentProps: JSON.stringify(seg.props),
        },
      } as unknown as Block);
    }
  }

  return allBlocks;
}

// BlockNote blocks → MDX string
export async function blocksToMdx(editor: Editor, blocks: Block[]): Promise<string> {
  const parts: string[] = [];

  // Group consecutive non-app blocks for markdown serialization
  let markdownBuffer: Block[] = [];

  async function flushMarkdown(): Promise<void> {
    if (markdownBuffer.length === 0) return;
    const md = await editor.blocksToMarkdownLossy(markdownBuffer);
    parts.push(md.trim());
    markdownBuffer = [];
  }

  for (const block of blocks) {
    const b = block as unknown as { type: string; props: Record<string, string> };
    if (b.type === "appComponent") {
      await flushMarkdown();
      // Serialize component tag
      const seg: ComponentSegment = {
        type: "component",
        name: b.props.componentName || "",
        props: safeJsonParse(b.props.componentProps),
        children: null,
        raw: "",
      };
      parts.push(serializeComponent(seg));
    } else {
      markdownBuffer.push(block);
    }
  }

  await flushMarkdown();
  return parts.join("\n\n") + "\n";
}

function safeJsonParse(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str || "{}");
  } catch {
    return {};
  }
}
