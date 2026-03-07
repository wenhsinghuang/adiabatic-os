import { describe, it, expect } from "vitest";
import {
  extractImports,
  stripAppImports,
  wrapExpressions,
  extractComponentJsx,
  patchSource,
  TAG_TO_MD,
  parseResizeWrapper,
  generateResizeWrapper,
} from "./mdx-utils";

// =========================================================================
// 1. Round-trip: strip imports → re-add imports should preserve structure
// =========================================================================

describe("extractImports", () => {
  it("extracts single named import", () => {
    const mdx = `import { Chart } from '@apps/analytics'`;
    expect(extractImports(mdx)).toEqual([
      { name: "Chart", appId: "analytics" },
    ]);
  });

  it("extracts multiple named imports from one line", () => {
    const mdx = `import { Chart, Table } from '@apps/analytics'`;
    expect(extractImports(mdx)).toEqual([
      { name: "Chart", appId: "analytics" },
      { name: "Table", appId: "analytics" },
    ]);
  });

  it("extracts imports from multiple apps", () => {
    const mdx = [
      `import { Chart } from '@apps/analytics'`,
      `import { Timer } from '@apps/focus'`,
    ].join("\n");
    expect(extractImports(mdx)).toEqual([
      { name: "Chart", appId: "analytics" },
      { name: "Timer", appId: "focus" },
    ]);
  });

  it("ignores non-app imports", () => {
    const mdx = `import { useState } from 'react'`;
    expect(extractImports(mdx)).toEqual([]);
  });

  it("handles double quotes", () => {
    const mdx = `import { Chart } from "@apps/analytics"`;
    expect(extractImports(mdx)).toEqual([
      { name: "Chart", appId: "analytics" },
    ]);
  });

  it("returns empty for no imports", () => {
    expect(extractImports("# Hello\n\nSome text")).toEqual([]);
  });
});

describe("stripAppImports", () => {
  it("strips single import line", () => {
    const mdx = `import { Chart } from '@apps/analytics'\n\n# Hello`;
    // \s*$ in the regex consumes trailing \n, so one \n is eaten
    expect(stripAppImports(mdx)).toBe("\n# Hello");
  });

  it("strips multiple import lines", () => {
    const mdx = [
      `import { Chart } from '@apps/analytics'`,
      `import { Timer } from '@apps/focus'`,
      "",
      "# Hello",
    ].join("\n");
    expect(stripAppImports(mdx)).toBe("\n\n# Hello");
  });

  it("preserves non-app imports", () => {
    const mdx = `import { useState } from 'react'\n\n# Hello`;
    expect(stripAppImports(mdx)).toBe(mdx);
  });

  it("strips import with trailing semicolon", () => {
    const mdx = `import { Chart } from '@apps/analytics';\n\n# Hello`;
    expect(stripAppImports(mdx)).toBe("\n# Hello");
  });

  it("handles mixed app and non-app imports", () => {
    const mdx = [
      `import { useState } from 'react'`,
      `import { Chart } from '@apps/analytics'`,
      "",
      "# Hello",
    ].join("\n");
    const result = stripAppImports(mdx);
    expect(result).toContain("import { useState } from 'react'");
    expect(result).not.toContain("@apps/analytics");
  });
});

// =========================================================================
// 2. Text patching
// =========================================================================

describe("patchSource", () => {
  it("replaces first occurrence", () => {
    const source = "Hello world";
    const result = patchSource(source, "world", "there");
    expect(result).toEqual({ patched: "Hello there", success: true });
  });

  it("returns failure when fragment not found", () => {
    const source = "Hello world";
    const result = patchSource(source, "missing", "replacement");
    expect(result).toEqual({ patched: "Hello world", success: false });
  });

  it("replaces only the first occurrence (duplicate text)", () => {
    const source = "hello hello hello";
    const result = patchSource(source, "hello", "bye");
    expect(result).toEqual({ patched: "bye hello hello", success: true });
  });

  it("handles multiline fragments", () => {
    const source = "line1\nline2\nline3";
    const result = patchSource(source, "line2\nline3", "changed");
    expect(result).toEqual({ patched: "line1\nchanged", success: true });
  });

  it("handles empty replacement (deletion)", () => {
    const source = "# Title\n\n<Chart />\n\nEnd";
    const result = patchSource(source, "<Chart />", "");
    expect(result).toEqual({ patched: "# Title\n\n\n\nEnd", success: true });
  });

  it("handles heading text patch", () => {
    const source = "# Hello World\n\nSome text";
    const result = patchSource(source, "# Hello World", "# Hello There");
    expect(result).toEqual({
      patched: "# Hello There\n\nSome text",
      success: true,
    });
  });

  it("patches markdown formatting", () => {
    const source = "Some **bold** text here";
    const result = patchSource(source, "Some **bold** text here", "Some **italic** text here");
    expect(result).toEqual({
      patched: "Some **italic** text here",
      success: true,
    });
  });

  it("patches link", () => {
    const source = "Check [this](https://old.com) out";
    const result = patchSource(
      source,
      "[this](https://old.com)",
      "[this](https://new.com)",
    );
    expect(result).toEqual({
      patched: "Check [this](https://new.com) out",
      success: true,
    });
  });

  it("patches component JSX", () => {
    const source = '# Title\n\n<Chart period="week" />\n\nEnd';
    const result = patchSource(
      source,
      '<Chart period="week" />',
      '<Chart period="month" />',
    );
    expect(result).toEqual({
      patched: '# Title\n\n<Chart period="month" />\n\nEnd',
      success: true,
    });
  });
});

// =========================================================================
// 3. Import extraction round-trip
// =========================================================================

describe("import round-trip", () => {
  it("extract then strip preserves non-import content exactly", () => {
    const mdx = [
      `import { Chart } from '@apps/analytics'`,
      "",
      "# Weekly Review",
      "",
      "Some text here.",
      "",
      '<Chart period="week" />',
    ].join("\n");

    const imports = extractImports(mdx);
    expect(imports).toHaveLength(1);

    const stripped = stripAppImports(mdx);
    expect(stripped).toContain("# Weekly Review");
    expect(stripped).toContain("Some text here.");
    expect(stripped).toContain('<Chart period="week" />');
    expect(stripped).not.toContain("@apps/analytics");
  });

  it("import content can be reconstructed", () => {
    const imports = [
      { name: "Chart", appId: "analytics" },
      { name: "Timer", appId: "focus" },
    ];
    const reconstructed = imports
      .map((i) => `import { ${i.name} } from '@apps/${i.appId}'`)
      .join("\n");
    expect(reconstructed).toBe(
      `import { Chart } from '@apps/analytics'\nimport { Timer } from '@apps/focus'`,
    );
  });
});

// =========================================================================
// 4. Component JSX extraction
// =========================================================================

describe("extractComponentJsx", () => {
  it("finds self-closing component", () => {
    const mdx = '# Title\n\n<Chart period="week" />\n\nEnd';
    expect(extractComponentJsx(mdx, "Chart")).toEqual([
      '<Chart period="week" />',
    ]);
  });

  it("finds component with children", () => {
    const mdx = "<Callout>\nSome text\n</Callout>";
    expect(extractComponentJsx(mdx, "Callout")).toEqual([
      "<Callout>\nSome text\n</Callout>",
    ]);
  });

  it("finds multiple usages in source order", () => {
    const mdx = '<Chart type="bar" />\n\nSome text\n\n<Chart type="line" />';
    const result = extractComponentJsx(mdx, "Chart");
    expect(result).toEqual(['<Chart type="bar" />', '<Chart type="line" />']);
  });

  it("does not match different component names", () => {
    const mdx = "<Chart />\n<Table />";
    expect(extractComponentJsx(mdx, "Chart")).toEqual(["<Chart />"]);
    expect(extractComponentJsx(mdx, "Table")).toEqual(["<Table />"]);
  });

  it("finds component with no props", () => {
    const mdx = "# Title\n\n<HelloWorld />";
    expect(extractComponentJsx(mdx, "HelloWorld")).toEqual(["<HelloWorld />"]);
  });

  it("does not double-count self-closing inside open/close search", () => {
    const mdx = "<Chart />";
    expect(extractComponentJsx(mdx, "Chart")).toEqual(["<Chart />"]);
  });

  it("returns empty for no matches", () => {
    expect(extractComponentJsx("# Just text", "Chart")).toEqual([]);
  });
});

// =========================================================================
// 5. Expression handling
// =========================================================================

describe("wrapExpressions", () => {
  it("wraps standalone expression", () => {
    const mdx = "# Title\n\n{1 + 4}\n\nEnd";
    const result = wrapExpressions(mdx);
    expect(result).toContain("<mdxexpr");
    expect(result).toContain("source=");
    expect(result).toContain("{1 + 4}");
  });

  it("does not wrap expression inside code block", () => {
    const mdx = "```\n{1 + 4}\n```";
    const result = wrapExpressions(mdx);
    expect(result).not.toContain("<mdxexpr");
    expect(result).toBe(mdx);
  });

  it("does not wrap inline expression within text", () => {
    const mdx = "The answer is {1 + 4} today";
    const result = wrapExpressions(mdx);
    // Not standalone — should not be wrapped
    expect(result).toBe(mdx);
  });

  it("does not wrap JSX comments", () => {
    const mdx = "{/* this is a comment */}";
    const result = wrapExpressions(mdx);
    expect(result).not.toContain("<mdxexpr");
  });

  it("does not wrap escaped expressions", () => {
    const mdx = "\\{not an expression}";
    const result = wrapExpressions(mdx);
    expect(result).not.toContain("<mdxexpr");
    expect(result).toBe(mdx);
  });

  it("wraps system.query expression", () => {
    const mdx = '{await system.query("SELECT count(*) FROM events")}';
    const result = wrapExpressions(mdx);
    expect(result).toContain("<mdxexpr");
    expect(result).toContain("system.query");
  });

  it("handles multiple standalone expressions", () => {
    const mdx = "{1 + 1}\n\n{2 + 2}";
    const result = wrapExpressions(mdx);
    const matches = result.match(/<mdxexpr/g);
    expect(matches).toHaveLength(2);
  });

  it("preserves non-expression lines unchanged", () => {
    const mdx = "# Title\n\nSome text\n\n- list item";
    expect(wrapExpressions(mdx)).toBe(mdx);
  });
});

// =========================================================================
// 6. Resize wrapper serialization
// =========================================================================

describe("parseResizeWrapper", () => {
  it("parses width and height", () => {
    const jsx = '<div style={{width: "500px", height: "300px"}}><Chart /></div>';
    const result = parseResizeWrapper(jsx);
    expect(result).toEqual({
      width: "500px",
      height: "300px",
      componentJsx: "<Chart />",
    });
  });

  it("parses width only", () => {
    const jsx = '<div style={{width: "500px"}}><Chart /></div>';
    const result = parseResizeWrapper(jsx);
    expect(result).toEqual({
      width: "500px",
      height: undefined,
      componentJsx: "<Chart />",
    });
  });

  it("parses height only", () => {
    const jsx = '<div style={{height: "300px"}}><Chart /></div>';
    const result = parseResizeWrapper(jsx);
    expect(result).toEqual({
      width: undefined,
      height: "300px",
      componentJsx: "<Chart />",
    });
  });

  it("parses component with props", () => {
    const jsx = '<div style={{width: "500px", height: "300px"}}><Chart period="week" /></div>';
    const result = parseResizeWrapper(jsx);
    expect(result).toEqual({
      width: "500px",
      height: "300px",
      componentJsx: '<Chart period="week" />',
    });
  });

  it("returns null for non-wrapper div", () => {
    expect(parseResizeWrapper("<div>just text</div>")).toBeNull();
  });

  it("returns null for div with mixed content", () => {
    expect(
      parseResizeWrapper(
        '<div style={{width: "500px"}}>text<Chart /></div>',
      ),
    ).toBeNull();
  });

  it("returns null for non-div JSX", () => {
    expect(parseResizeWrapper("<Chart />")).toBeNull();
  });

  it("returns null for div with style but no width/height", () => {
    expect(
      parseResizeWrapper(
        '<div style={{color: "red"}}><Chart /></div>',
      ),
    ).toBeNull();
  });
});

describe("generateResizeWrapper", () => {
  it("generates wrapper with width and height", () => {
    const result = generateResizeWrapper("<Chart />", "500px", "300px");
    expect(result).toBe(
      '<div style={{width: "500px", height: "300px"}}><Chart /></div>',
    );
  });

  it("generates wrapper with width only", () => {
    const result = generateResizeWrapper("<Chart />", "500px");
    expect(result).toBe('<div style={{width: "500px"}}><Chart /></div>');
  });

  it("generates wrapper with height only", () => {
    const result = generateResizeWrapper("<Chart />", undefined, "300px");
    expect(result).toBe('<div style={{height: "300px"}}><Chart /></div>');
  });

  it("returns raw JSX when no dimensions", () => {
    const result = generateResizeWrapper("<Chart />");
    expect(result).toBe("<Chart />");
  });

  it("preserves component props", () => {
    const result = generateResizeWrapper(
      '<Chart period="week" />',
      "500px",
      "300px",
    );
    expect(result).toBe(
      '<div style={{width: "500px", height: "300px"}}><Chart period="week" /></div>',
    );
  });
});

describe("resize round-trip", () => {
  it("parse then generate reproduces original", () => {
    const original =
      '<div style={{width: "500px", height: "300px"}}><Chart /></div>';
    const parsed = parseResizeWrapper(original);
    expect(parsed).not.toBeNull();
    const regenerated = generateResizeWrapper(
      parsed!.componentJsx,
      parsed!.width,
      parsed!.height,
    );
    expect(regenerated).toBe(original);
  });

  it("round-trips with component props", () => {
    const original =
      '<div style={{width: "100%", height: "400px"}}><FocusChart period="week" /></div>';
    const parsed = parseResizeWrapper(original);
    expect(parsed).not.toBeNull();
    const regenerated = generateResizeWrapper(
      parsed!.componentJsx,
      parsed!.width,
      parsed!.height,
    );
    expect(regenerated).toBe(original);
  });
});

// =========================================================================
// 7. TAG_TO_MD mapping
// =========================================================================

describe("TAG_TO_MD", () => {
  it("converts strong to bold", () => {
    expect(TAG_TO_MD.strong("text")).toBe("**text**");
  });

  it("converts em to italic", () => {
    expect(TAG_TO_MD.em("text")).toBe("_text_");
  });

  it("converts code to backtick", () => {
    expect(TAG_TO_MD.code("text")).toBe("`text`");
  });

  it("converts del to strikethrough", () => {
    expect(TAG_TO_MD.del("text")).toBe("~~text~~");
  });

  it("converts a to link", () => {
    expect(TAG_TO_MD.a("click here", { href: "https://example.com" })).toBe(
      "[click here](https://example.com)",
    );
  });

  it("converts a with missing href", () => {
    expect(TAG_TO_MD.a("click here")).toBe("[click here]()");
  });

  it("converts br to newline", () => {
    expect(TAG_TO_MD.br("")).toBe("\n");
  });
});

// =========================================================================
// 8. Full MDX structure round-trip (patch-based)
// =========================================================================

describe("full MDX structure preservation", () => {
  const fullMdx = [
    `import { Chart } from '@apps/analytics'`,
    `import { Timer } from '@apps/focus'`,
    "",
    "# Weekly Review",
    "",
    "This week I focused **32 hours**.",
    "",
    '<Chart period="week" />',
    "",
    "## Notes",
    "",
    "- Item one",
    "- Item two",
    "",
    "{1 + 1}",
    "",
    "Check [this link](https://example.com) out.",
    "",
    '<div style={{width: "500px", height: "300px"}}><Timer /></div>',
  ].join("\n");

  it("extractImports finds all app imports", () => {
    const imports = extractImports(fullMdx);
    expect(imports).toEqual([
      { name: "Chart", appId: "analytics" },
      { name: "Timer", appId: "focus" },
    ]);
  });

  it("stripAppImports removes only app imports", () => {
    const stripped = stripAppImports(fullMdx);
    expect(stripped).not.toContain("@apps/");
    expect(stripped).toContain("# Weekly Review");
    expect(stripped).toContain("**32 hours**");
    expect(stripped).toContain('<Chart period="week" />');
    expect(stripped).toContain("{1 + 1}");
    expect(stripped).toContain("[this link](https://example.com)");
  });

  it("extractComponentJsx finds all component usages", () => {
    expect(extractComponentJsx(fullMdx, "Chart")).toEqual([
      '<Chart period="week" />',
    ]);
    expect(extractComponentJsx(fullMdx, "Timer")).toEqual(["<Timer />"]);
  });

  it("patching heading preserves everything else", () => {
    const { patched, success } = patchSource(
      fullMdx,
      "# Weekly Review",
      "# Monthly Review",
    );
    expect(success).toBe(true);
    expect(patched).toContain("# Monthly Review");
    expect(patched).toContain("**32 hours**");
    expect(patched).toContain('<Chart period="week" />');
    // Verify imports still intact
    expect(extractImports(patched)).toHaveLength(2);
  });

  it("patching text preserves structure", () => {
    const { patched, success } = patchSource(
      fullMdx,
      "This week I focused **32 hours**.",
      "This week I focused **40 hours**.",
    );
    expect(success).toBe(true);
    expect(patched).toContain("**40 hours**");
    expect(patched).toContain("# Weekly Review");
    expect(patched).toContain('<Chart period="week" />');
  });

  it("patching component preserves text", () => {
    const { patched, success } = patchSource(
      fullMdx,
      '<Chart period="week" />',
      '<Chart period="month" />',
    );
    expect(success).toBe(true);
    expect(patched).toContain('<Chart period="month" />');
    expect(patched).toContain("# Weekly Review");
    expect(patched).toContain("**32 hours**");
  });

  it("deleting component preserves text", () => {
    const { patched, success } = patchSource(
      fullMdx,
      '<Chart period="week" />',
      "",
    );
    expect(success).toBe(true);
    expect(patched).not.toContain("<Chart");
    expect(patched).toContain("# Weekly Review");
    expect(patched).toContain("**32 hours**");
    expect(patched).toContain("<Timer />");
  });

  it("patching link preserves structure", () => {
    const { patched, success } = patchSource(
      fullMdx,
      "[this link](https://example.com)",
      "[this link](https://new.com)",
    );
    expect(success).toBe(true);
    expect(patched).toContain("https://new.com");
    expect(patched).toContain("# Weekly Review");
  });

  it("resize wrapper round-trips within full doc", () => {
    const wrapperStr =
      '<div style={{width: "500px", height: "300px"}}><Timer /></div>';
    expect(fullMdx).toContain(wrapperStr);

    const parsed = parseResizeWrapper(wrapperStr);
    expect(parsed).not.toBeNull();
    expect(parsed!.componentJsx).toBe("<Timer />");

    const regenerated = generateResizeWrapper(
      parsed!.componentJsx,
      parsed!.width,
      parsed!.height,
    );
    expect(regenerated).toBe(wrapperStr);
  });
});
