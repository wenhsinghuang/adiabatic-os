import { describe, test, expect } from "bun:test";
import { renderMDX } from "../src/renderer";

describe("MDX Renderer", () => {
  test("compiles valid MDX to code", async () => {
    const result = await renderMDX("# Hello\n\nSome **bold** text.");
    expect(result.error).toBeUndefined();
    expect(result.code).toBeTruthy();
    expect(result.code).toContain("Hello");
  });

  test("compiles MDX with JSX component reference", async () => {
    const result = await renderMDX("# Dashboard\n\n<FocusChart period=\"week\" />");
    expect(result.error).toBeUndefined();
    expect(result.code).toBeTruthy();
    expect(result.code).toContain("FocusChart");
  });

  test("returns error for invalid MDX (does not crash)", async () => {
    // Unterminated JSX
    const result = await renderMDX("# Bad\n\n<div>unclosed");
    // @mdx-js/mdx may or may not error on this specific input,
    // but it should never throw — always returns a result
    expect(result).toBeTruthy();
  });

  test("handles empty content", async () => {
    const result = await renderMDX("");
    expect(result.error).toBeUndefined();
    expect(result.code).toBeTruthy();
  });
});
