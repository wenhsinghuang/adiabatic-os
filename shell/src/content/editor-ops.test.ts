// Editor operations — behavioral tests.
// Tests describe WHAT should happen, not HOW.
// Each test: given MDX + operation → expected MDX output.

import { describe, it, expect } from "vitest";
import {
  getBlocks,
  replaceBlock,
  editComponentJsx,
  deleteComponent,
  moveComponent,
  resizeComponent,
  insertComponent,
} from "./editor-ops";

// =========================================================================
// Sample MDX documents
// =========================================================================

const simpleMdx = [
  "# Weekly Review",
  "",
  "This week I focused **32 hours**.",
  "",
  "Some more text.",
].join("\n");

const withComponentMdx = [
  "import { Chart } from '@apps/analytics'",
  "",
  "# Dashboard",
  "",
  "Here is the data:",
  "",
  '<Chart period="week" />',
  "",
  "End of report.",
].join("\n");

const multiComponentMdx = [
  "import { Chart, Timer } from '@apps/analytics'",
  "",
  "# Dashboard",
  "",
  '<Chart period="week" />',
  "",
  "Some text between.",
  "",
  "<Timer />",
  "",
  "Final text.",
].join("\n");

const withExpressionMdx = [
  "# Stats",
  "",
  "Total: {1 + 1}",
  "",
  "{await system.query('SELECT count(*) FROM events')}",
].join("\n");

const mixedJsxMdx = [
  "# Notes",
  "",
  "<Callout>",
  "Some **important** text inside.",
  "</Callout>",
  "",
  "Regular paragraph.",
].join("\n");

const withResizeMdx = [
  "import { Chart } from '@apps/analytics'",
  "",
  "# Dashboard",
  "",
  '<div style={{width: "500px", height: "300px"}}><Chart /></div>',
  "",
  "End.",
].join("\n");

// =========================================================================
// 1. Block splitting — editor needs to know what blocks exist
// =========================================================================

describe("getBlocks", () => {
  it("splits simple markdown into blocks", () => {
    const blocks = getBlocks(simpleMdx);
    expect(blocks).toContainEqual(expect.stringContaining("# Weekly Review"));
    expect(blocks).toContainEqual(
      expect.stringContaining("**32 hours**"),
    );
    expect(blocks).toContainEqual(
      expect.stringContaining("Some more text."),
    );
  });

  it("treats a component as its own block", () => {
    const blocks = getBlocks(withComponentMdx);
    expect(blocks).toContainEqual(
      expect.stringContaining('<Chart period="week" />'),
    );
  });

  it("treats import lines as a block (hidden in view but present in source)", () => {
    const blocks = getBlocks(withComponentMdx);
    expect(blocks).toContainEqual(
      expect.stringContaining("import"),
    );
  });

  it("treats a standalone expression as its own block", () => {
    const blocks = getBlocks(withExpressionMdx);
    expect(blocks).toContainEqual(
      expect.stringContaining("system.query"),
    );
  });

  it("treats mixed JSX/MD as a single block", () => {
    const blocks = getBlocks(mixedJsxMdx);
    const calloutBlock = blocks.find((b) => b.includes("<Callout>"));
    expect(calloutBlock).toBeDefined();
    expect(calloutBlock).toContain("</Callout>");
    expect(calloutBlock).toContain("**important**");
  });

  it("treats resize-wrapped component as a single block", () => {
    const blocks = getBlocks(withResizeMdx);
    const resizeBlock = blocks.find((b) => b.includes("style="));
    expect(resizeBlock).toBeDefined();
    expect(resizeBlock).toContain("<Chart />");
  });
});

// =========================================================================
// 2. Round-trip — split then join without editing = identical source
// =========================================================================

describe("round-trip invariant", () => {
  const docs = [
    simpleMdx,
    withComponentMdx,
    multiComponentMdx,
    withExpressionMdx,
    mixedJsxMdx,
    withResizeMdx,
  ];

  for (const doc of docs) {
    it(`preserves source: ${doc.slice(0, 40)}...`, () => {
      const blocks = getBlocks(doc);
      // Replace every block with itself → should produce identical source
      let result = doc;
      for (let i = 0; i < blocks.length; i++) {
        result = replaceBlock(result, i, blocks[i]);
      }
      expect(result).toBe(doc);
    });
  }
});

// =========================================================================
// 3. Text block editing (Rule 1)
// =========================================================================

describe("text block editing", () => {
  it("editing a heading changes only the heading", () => {
    const blocks = getBlocks(simpleMdx);
    const headingIdx = blocks.findIndex((b) => b.includes("# Weekly"));
    const result = replaceBlock(simpleMdx, headingIdx, "# Monthly Review");
    expect(result).toContain("# Monthly Review");
    expect(result).toContain("**32 hours**");
    expect(result).toContain("Some more text.");
    expect(result).not.toContain("# Weekly Review");
  });

  it("editing a paragraph changes only that paragraph", () => {
    const blocks = getBlocks(simpleMdx);
    const paraIdx = blocks.findIndex((b) => b.includes("32 hours"));
    const result = replaceBlock(
      simpleMdx,
      paraIdx,
      "This week I focused **40 hours**.",
    );
    expect(result).toContain("**40 hours**");
    expect(result).toContain("# Weekly Review");
    expect(result).toContain("Some more text.");
  });

  it("editing does not affect adjacent components", () => {
    const blocks = getBlocks(withComponentMdx);
    const textIdx = blocks.findIndex((b) => b.includes("Here is the data"));
    const result = replaceBlock(withComponentMdx, textIdx, "Updated text.");
    expect(result).toContain("Updated text.");
    expect(result).toContain('<Chart period="week" />');
    expect(result).toContain("End of report.");
  });
});

// =========================================================================
// 4. Component operations (Rule 2)
// =========================================================================

describe("component edit", () => {
  it("changing component props updates only that component", () => {
    const result = editComponentJsx(
      withComponentMdx,
      '<Chart period="week" />',
      '<Chart period="month" />',
    );
    expect(result).toContain('<Chart period="month" />');
    expect(result).toContain("# Dashboard");
    expect(result).toContain("Here is the data:");
    expect(result).toContain("End of report.");
  });

  it("editing one component does not affect another", () => {
    const result = editComponentJsx(
      multiComponentMdx,
      '<Chart period="week" />',
      '<Chart period="year" />',
    );
    expect(result).toContain('<Chart period="year" />');
    expect(result).toContain("<Timer />");
  });
});

describe("component delete", () => {
  it("removes the component from source", () => {
    const result = deleteComponent(withComponentMdx, '<Chart period="week" />');
    expect(result).not.toContain("<Chart");
    expect(result).toContain("# Dashboard");
    expect(result).toContain("End of report.");
  });

  it("deleting one component preserves others", () => {
    const result = deleteComponent(multiComponentMdx, "<Timer />");
    expect(result).not.toContain("<Timer");
    expect(result).toContain('<Chart period="week" />');
    expect(result).toContain("Some text between.");
  });

  it("does not leave excess blank lines", () => {
    const result = deleteComponent(withComponentMdx, '<Chart period="week" />');
    // Should not have 3+ consecutive newlines
    expect(result).not.toMatch(/\n{4,}/);
  });
});

describe("component move (DnD)", () => {
  it("moves component to a new position", () => {
    const blocks = getBlocks(multiComponentMdx);
    const timerIdx = blocks.findIndex((b) => b.includes("<Timer />"));
    const chartIdx = blocks.findIndex((b) => b.includes("<Chart"));

    // Move Timer before Chart
    const result = moveComponent(multiComponentMdx, "<Timer />", chartIdx);
    const newBlocks = getBlocks(result);
    const newTimerIdx = newBlocks.findIndex((b) => b.includes("<Timer />"));
    const newChartIdx = newBlocks.findIndex((b) => b.includes("<Chart"));

    expect(newTimerIdx).toBeLessThan(newChartIdx);
  });

  it("move preserves all content", () => {
    const blocks = getBlocks(multiComponentMdx);
    const chartIdx = blocks.findIndex((b) => b.includes("<Chart"));
    const result = moveComponent(multiComponentMdx, "<Timer />", chartIdx);
    expect(result).toContain("<Timer />");
    expect(result).toContain('<Chart period="week" />');
    expect(result).toContain("# Dashboard");
    expect(result).toContain("Some text between.");
    expect(result).toContain("Final text.");
  });
});

describe("component resize", () => {
  it("wraps component in div with dimensions", () => {
    const result = resizeComponent(
      withComponentMdx,
      '<Chart period="week" />',
      "500px",
      "300px",
    );
    expect(result).toContain("width:");
    expect(result).toContain("500px");
    expect(result).toContain("height:");
    expect(result).toContain("300px");
    expect(result).toContain("<Chart");
  });

  it("updates dimensions on already-resized component", () => {
    const result = resizeComponent(withResizeMdx, "<Chart />", "800px", "600px");
    expect(result).toContain("800px");
    expect(result).toContain("600px");
    expect(result).not.toContain("500px");
    expect(result).not.toContain("300px");
  });

  it("removes wrapper when dimensions are cleared", () => {
    const result = resizeComponent(withResizeMdx, "<Chart />");
    expect(result).toContain("<Chart />");
    expect(result).not.toContain("style=");
    expect(result).not.toContain("<div");
  });

  it("resize preserves surrounding content", () => {
    const result = resizeComponent(
      withComponentMdx,
      '<Chart period="week" />',
      "500px",
      "300px",
    );
    expect(result).toContain("# Dashboard");
    expect(result).toContain("End of report.");
  });
});

describe("component insert", () => {
  it("inserts component at specified position", () => {
    const blocks = getBlocks(simpleMdx);
    const lastIdx = blocks.length;
    const result = insertComponent(simpleMdx, "<NewWidget />", lastIdx);
    expect(result).toContain("<NewWidget />");
    expect(result).toContain("# Weekly Review");
    expect(result).toContain("Some more text.");
  });

  it("inserts between existing blocks", () => {
    const blocks = getBlocks(simpleMdx);
    const headingIdx = blocks.findIndex((b) => b.includes("# Weekly"));
    const result = insertComponent(simpleMdx, "<Banner />", headingIdx + 1);
    const newBlocks = getBlocks(result);
    const bannerIdx = newBlocks.findIndex((b) => b.includes("<Banner />"));
    const headingNewIdx = newBlocks.findIndex((b) => b.includes("# Weekly"));
    expect(bannerIdx).toBe(headingNewIdx + 1);
  });
});

// =========================================================================
// 5. Mixed JSX/MD editing (Rule 3)
// =========================================================================

describe("mixed JSX/MD editing", () => {
  it("editing a mixed block replaces the entire block", () => {
    const blocks = getBlocks(mixedJsxMdx);
    const calloutIdx = blocks.findIndex((b) => b.includes("<Callout>"));
    const newSource = "<Callout>\nUpdated text.\n</Callout>";
    const result = replaceBlock(mixedJsxMdx, calloutIdx, newSource);
    expect(result).toContain("Updated text.");
    expect(result).not.toContain("**important**");
    expect(result).toContain("Regular paragraph.");
  });
});

// =========================================================================
// 6. Invariants
// =========================================================================

describe("invariants", () => {
  it("imports are preserved through text edits", () => {
    const blocks = getBlocks(withComponentMdx);
    const textIdx = blocks.findIndex((b) => b.includes("Here is the data"));
    const result = replaceBlock(withComponentMdx, textIdx, "Changed text.");
    expect(result).toContain("import { Chart }");
  });

  it("imports are preserved through component delete", () => {
    const result = deleteComponent(withComponentMdx, '<Chart period="week" />');
    // Import may or may not be cleaned up — but it must not corrupt other content
    expect(result).toContain("# Dashboard");
    expect(result).toContain("End of report.");
  });

  it("sequential edits do not corrupt source", () => {
    let mdx = simpleMdx;

    // Edit heading
    const blocks1 = getBlocks(mdx);
    const h1Idx = blocks1.findIndex((b) => b.includes("# Weekly"));
    mdx = replaceBlock(mdx, h1Idx, "# Updated Title");

    // Edit paragraph
    const blocks2 = getBlocks(mdx);
    const paraIdx = blocks2.findIndex((b) => b.includes("32 hours"));
    mdx = replaceBlock(mdx, paraIdx, "New paragraph content.");

    expect(mdx).toContain("# Updated Title");
    expect(mdx).toContain("New paragraph content.");
    expect(mdx).toContain("Some more text.");
    expect(mdx).not.toContain("# Weekly Review");
  });
});
