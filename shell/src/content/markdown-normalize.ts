const RAW_MDX_FENCE = "```mdx";

function isFence(line: string): boolean {
  return line.trimStart().startsWith("```") || line.trimStart().startsWith("~~~");
}

function isUnsupportedMdxOrHtmlLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^import\s.+\sfrom\s+["'][^"']+["'];?$/.test(trimmed) ||
    /^export\s+/.test(trimmed) ||
    /^<\/?[A-Za-z][\w.:/-]*(\s|>|\/>)/.test(trimmed) ||
    /^<!--/.test(trimmed)
  );
}

export function inertUnsupportedMdx(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let inFence = false;
  let rawBlock: string[] = [];

  const flushRawBlock = () => {
    if (rawBlock.length === 0) return;
    output.push(RAW_MDX_FENCE, ...rawBlock, "```");
    rawBlock = [];
  };

  for (const line of lines) {
    if (isFence(line)) {
      flushRawBlock();
      inFence = !inFence;
      output.push(line);
      continue;
    }

    if (!inFence && isUnsupportedMdxOrHtmlLine(line)) {
      rawBlock.push(line);
      continue;
    }

    flushRawBlock();
    output.push(line);
  }

  flushRawBlock();
  return output.join("\n");
}
