import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { openDB } from "../src/db";
import { Guard } from "../src/guard";
import { WorkingTree } from "../src/working-tree";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("WorkingTree", () => {
  let workspace: string;
  let pagesDir: string;
  let db: ReturnType<typeof openDB>["db"];
  let close: () => void;
  let guard: Guard;
  let tree: WorkingTree;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "adiabatic-test-"));
    pagesDir = join(workspace, "pages");
    mkdirSync(join(workspace, ".adiabatic"), { recursive: true });
    const result = openDB(workspace);
    db = result.db;
    close = result.close;
    guard = new Guard({ db, source: "system:test" });
    tree = new WorkingTree({ guard, pagesDir });
  });

  afterEach(() => {
    tree.stop();
    close();
    rmSync(workspace, { recursive: true, force: true });
  });

  // -- DB → File --

  test("writeDoc materializes .mdx file", async () => {
    await tree.start();
    guard.writeDoc("journal/today", "# Today\n\nSome notes.");

    // Give file system a moment
    await Bun.sleep(50);

    const filePath = join(pagesDir, "journal/today.mdx");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("# Today\n\nSome notes.");
  });

  test("deleteDoc removes .mdx file", async () => {
    await tree.start();
    guard.writeDoc("to-remove", "bye");
    await Bun.sleep(50);

    const filePath = join(pagesDir, "to-remove.mdx");
    expect(existsSync(filePath)).toBe(true);

    guard.deleteDoc("to-remove");
    await Bun.sleep(50);

    expect(existsSync(filePath)).toBe(false);
  });

  // -- File → DB --

  test("existing .mdx files are loaded on start", async () => {
    // Create file before starting tree
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(join(pagesDir, "existing.mdx"), "# Existing Doc");

    await tree.start();

    const doc = guard.queryOne("SELECT * FROM docs WHERE id = ?", ["existing"]) as any;
    expect(doc).toBeTruthy();
    expect(doc.content).toBe("# Existing Doc");
  });

  test("nested .mdx files are loaded with correct doc id", async () => {
    mkdirSync(join(pagesDir, "notes"), { recursive: true });
    writeFileSync(join(pagesDir, "notes/ideas.mdx"), "# Ideas");

    await tree.start();

    const doc = guard.queryOne("SELECT * FROM docs WHERE id = ?", ["notes/ideas"]) as any;
    expect(doc).toBeTruthy();
    expect(doc.content).toBe("# Ideas");
  });

  // -- pages/ directory creation --

  test("start creates pages/ directory if missing", async () => {
    expect(existsSync(pagesDir)).toBe(false);
    await tree.start();
    expect(existsSync(pagesDir)).toBe(true);
  });
});
