import { compile } from "@mdx-js/mdx";

// MDX Renderer — compiles MDX strings to JS code.
// Component resolver maps <ComponentName /> to app registry entries.

export interface RenderResult {
  code: string;
  error?: undefined;
}

export interface RenderError {
  code?: undefined;
  error: string;
}

export type RenderOutput = RenderResult | RenderError;

// Rehype plugin: annotate block-level elements with source line numbers.
// This lets the editor map rendered DOM elements back to source blocks.
const blockTags = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "ul", "ol", "blockquote", "pre", "hr", "table", "div", "details",
]);

function walkTree(node: any, fn: (n: any) => void) {
  fn(node);
  if (node.children) {
    for (const child of node.children) walkTree(child, fn);
  }
}

function rehypeSourceLines() {
  return (tree: any) => {
    walkTree(tree, (node: any) => {
      if (node.type === "element" && node.position && blockTags.has(node.tagName)) {
        node.properties = node.properties || {};
        node.properties["data-source-line"] = node.position.start.line;
      }
    });
  };
}

export async function renderMDX(
  mdxContent: string,
  components?: string[], // available component names for resolution
): Promise<RenderOutput> {
  try {
    const result = await compile(mdxContent, {
      outputFormat: "function-body",
      development: false,
      rehypePlugins: [rehypeSourceLines],
    });

    return { code: String(result) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}
