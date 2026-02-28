import { watch, type FSWatcher } from "fs";
import { readFile, writeFile, mkdir, unlink, readdir, stat } from "fs/promises";
import { join, relative, dirname } from "path";
import type { Guard } from "./guard";

// Working Tree — bidirectional sync between DB (source of truth) and pages/ directory.
// DB → File: Guard.onDocChange callback materializes .mdx files
// File → DB: fs.watch detects changes and calls guard.writeDoc()
// Anti-loop: DB-triggered writes set a flag so the file watcher skips them.

export interface WorkingTreeOptions {
  guard: Guard;
  pagesDir: string;
}

export class WorkingTree {
  private guard: Guard;
  private pagesDir: string;
  private watcher: FSWatcher | null = null;
  private dbTriggered = new Set<string>(); // paths currently being written by DB→File

  constructor(opts: WorkingTreeOptions) {
    this.guard = opts.guard;
    this.pagesDir = opts.pagesDir;

    // Hook into Guard doc changes (DB → File)
    this.guard.onDocChange = (id, content) => {
      if (content === null) {
        this.removeFile(id);
      } else {
        this.materializeFile(id, content);
      }
    };
  }

  // Start watching pages/ for file changes (File → DB)
  async start(): Promise<void> {
    await mkdir(this.pagesDir, { recursive: true });

    // Initial sync: load existing .mdx files into DB
    await this.loadExistingFiles();

    this.watcher = watch(this.pagesDir, { recursive: true }, (eventType, filename) => {
      if (!filename || !filename.endsWith(".mdx")) return;
      const fullPath = join(this.pagesDir, filename);

      // Anti-loop: skip if this write was triggered by DB→File
      if (this.dbTriggered.has(fullPath)) return;

      this.syncFileToDb(filename, fullPath);
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  // DB → File: materialize a doc as .mdx
  private async materializeFile(docId: string, content: string): Promise<void> {
    const filePath = join(this.pagesDir, docId + ".mdx");

    this.dbTriggered.add(filePath);
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
    } finally {
      // Clear flag after a short delay (let watcher event pass)
      setTimeout(() => this.dbTriggered.delete(filePath), 100);
    }
  }

  // DB → File: remove a deleted doc's file
  private async removeFile(docId: string): Promise<void> {
    const filePath = join(this.pagesDir, docId + ".mdx");
    this.dbTriggered.add(filePath);
    try {
      await unlink(filePath).catch(() => {}); // ignore if already gone
    } finally {
      setTimeout(() => this.dbTriggered.delete(filePath), 100);
    }
  }

  // File → DB: sync a changed file back to DB
  private async syncFileToDb(filename: string, fullPath: string): Promise<void> {
    try {
      const content = await readFile(fullPath, "utf8");
      const docId = filename.replace(/\.mdx$/, "");

      // Temporarily unhook onDocChange to prevent loop
      const savedHook = this.guard.onDocChange;
      this.guard.onDocChange = undefined;
      try {
        this.guard.writeDoc(docId, content);
      } finally {
        this.guard.onDocChange = savedHook;
      }
    } catch (err: unknown) {
      // File might have been deleted between event and read
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  // Load existing .mdx files on startup
  private async loadExistingFiles(dir?: string): Promise<void> {
    const currentDir = dir ?? this.pagesDir;
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await this.loadExistingFiles(fullPath);
      } else if (entry.name.endsWith(".mdx")) {
        const rel = relative(this.pagesDir, fullPath);
        const docId = rel.replace(/\.mdx$/, "");
        const content = await readFile(fullPath, "utf8");

        // Only write if doc doesn't exist in DB (don't overwrite DB on restart)
        const existing = this.guard.queryOne("SELECT id FROM docs WHERE id = ?", [docId]);
        if (!existing) {
          const savedHook = this.guard.onDocChange;
          this.guard.onDocChange = undefined;
          try {
            this.guard.writeDoc(docId, content);
          } finally {
            this.guard.onDocChange = savedHook;
          }
        }
      }
    }
  }
}
