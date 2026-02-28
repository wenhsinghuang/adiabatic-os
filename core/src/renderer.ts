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

export async function renderMDX(
  mdxContent: string,
  components?: string[], // available component names for resolution
): Promise<RenderOutput> {
  try {
    const result = await compile(mdxContent, {
      outputFormat: "function-body",
      development: false,
    });

    return { code: String(result) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}
