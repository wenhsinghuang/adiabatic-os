import { describe, expect, test } from "vitest";
import { inertUnsupportedMdx } from "./markdown-normalize";

describe("inertUnsupportedMdx", () => {
  test("wraps legacy imports and component tags in inert mdx code blocks", () => {
    const result = inertUnsupportedMdx(
      [
        'import { HelloWorld } from "@apps/hello-world"',
        "",
        "# Page",
        "",
        "<HelloWorld />",
      ].join("\n"),
    );

    expect(result).toContain('```mdx\nimport { HelloWorld } from "@apps/hello-world"\n```');
    expect(result).toContain("```mdx\n<HelloWorld />\n```");
    expect(result).toContain("# Page");
  });

  test("wraps raw HTML so the markdown editor never tries to execute or parse it", () => {
    const result = inertUnsupportedMdx(["# Page", "", "<div class=\"x\">", "content", "</div>"].join("\n"));

    expect(result).toContain('```mdx\n<div class="x">\n```');
    expect(result).toContain("content");
    expect(result).toContain("```mdx\n</div>\n```");
  });

  test("leaves existing fenced blocks alone", () => {
    const markdown = ["```html", "<div>already inert</div>", "```"].join("\n");
    expect(inertUnsupportedMdx(markdown)).toBe(markdown);
  });
});
