import { describe, expect, test } from "bun:test";
import { join } from "path";
import { resolveDocFilePath, validateDocId } from "../src/doc-id";

describe("doc id validation", () => {
  test("allows normal page ids", () => {
    expect(() => validateDocId("journal/today")).not.toThrow();
    expect(() => validateDocId("stress-test")).not.toThrow();
    expect(() => validateDocId("folder/untitled")).not.toThrow();
  });

  test("rejects traversal and ambiguous ids", () => {
    for (const id of [
      "",
      " ../x",
      "../x",
      "/tmp/x",
      "a/../x",
      "a//x",
      "a/./x",
      "a\\x",
      "a/\x00x",
    ]) {
      expect(() => validateDocId(id)).toThrow("Invalid doc id");
    }
  });

  test("resolves doc files inside pages directory", () => {
    const pagesDir = "/tmp/workspace/pages";
    expect(resolveDocFilePath(pagesDir, "journal/today")).toBe(
      join(pagesDir, "journal/today.mdx"),
    );
    expect(() => resolveDocFilePath(pagesDir, "../outside")).toThrow("Invalid doc id");
  });
});
