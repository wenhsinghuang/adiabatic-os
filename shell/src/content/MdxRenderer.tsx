// MdxRenderer — Obsidian-style MDX WYSIWYG editor.
//
// Architecture:
//   1. Compile FULL MDX document → one React component → render read-only
//   2. Click on text → overlay a chrome-less Monaco editor with raw MDX source
//   3. Blur → save, Escape → cancel, recompile
//   4. Component blocks: wrapped with name bar via MDX components prop

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  createContext,
  useContext,
} from "react";
import { run } from "@mdx-js/mdx";
import * as jsxRuntime from "react/jsx-runtime";
import { renderMdx } from "../lib/api";
import { appModuleLoader } from "../sandbox/app-bundler";
import { createSystemBridge } from "../sandbox/system-bridge";
import { ErrorBoundary } from "../components/ErrorBoundary";
import {
  getBlocks,
  replaceBlock,
  editComponentJsx,
  deleteComponent,
  moveComponent,
  resizeComponent,
  insertComponent,
  ensureImport,
} from "./editor-ops";
import { useApps } from "../hooks/useApps";
import { SlashPalette, type SlashItem } from "./SlashPalette";
import { InlineBlockEditor } from "./InlineBlockEditor";
import styles from "./MdxRenderer.module.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MdxRendererProps {
  content: string;
  onSave: (content: string) => void;
}

type BlockType = "import" | "component" | "text";

interface EditingState {
  blockIdx: number;
  source: string;
  rect: { top: number; left: number; width: number; height: number };
  hiddenEl: HTMLElement | null; // rendered element hidden during editing
}

// ---------------------------------------------------------------------------
// Block helpers
// ---------------------------------------------------------------------------

function classifyBlock(block: string): BlockType {
  const trimmed = block.trim();
  if (/^import\s/.test(trimmed) || /^export\s/.test(trimmed)) return "import";
  if (/^<[A-Z][A-Za-z0-9]*\b[^>]*\/>$/.test(trimmed)) return "component";
  if (/^<[A-Z]/.test(trimmed) && /^<\/[A-Z][A-Za-z0-9]*>$/m.test(trimmed)) {
    const inner = trimmed.replace(/^<[^>]+>/, "").replace(/<\/[^>]+>$/, "").trim();
    if (!inner || /^[{<]/.test(inner)) return "component";
  }
  if (/^<div\s+style=\{\{/.test(trimmed) && trimmed.endsWith("</div>")) return "component";
  return "text";
}

function getComponentJsx(block: string): string {
  const trimmed = block.trim();
  const inner = /^<div\s+style=\{\{[^}]*\}\}>(.+)<\/div>$/.exec(trimmed);
  return inner ? inner[1] : trimmed;
}

function normalizeHref(href: string): string {
  if (!href) return href;
  if (/^(https?:\/\/|mailto:|tel:|#)/.test(href)) return href;
  if (href.startsWith("www.")) return "https://" + href;
  return href;
}

// ---------------------------------------------------------------------------
// Import handling
// ---------------------------------------------------------------------------

function extractImports(mdx: string): { name: string; appId: string }[] {
  const imports: { name: string; appId: string }[] = [];
  const re = /import\s*\{([^}]+)\}\s*from\s*['"]@apps\/([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(mdx)) !== null) {
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    const appId = m[2];
    for (const name of names) imports.push({ name, appId });
  }
  return imports;
}

function stripAppImports(mdx: string): string {
  return mdx.replace(
    /^import[ \t]*\{[^}]+\}[ \t]*from[ \t]*['"]@apps\/[^'"]+['"][ \t]*;?[ \t]*$/gm,
    "",
  );
}

function extractComponentJsx(mdx: string, name: string): string[] {
  const usages: { text: string; index: number }[] = [];
  const re1 = new RegExp(`<${name}\\b[^>]*?\\/>`, "g");
  let m;
  while ((m = re1.exec(mdx)) !== null) {
    usages.push({ text: m[0], index: m.index });
  }
  const re2 = new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}>`, "g");
  while ((m = re2.exec(mdx)) !== null) {
    if (!usages.some((u) => u.index === m!.index)) {
      usages.push({ text: m[0], index: m.index });
    }
  }
  usages.sort((a, b) => a.index - b.index);
  return usages.map((u) => u.text);
}

// ---------------------------------------------------------------------------
// Editor context — lets ComponentBlock access editor operations
// ---------------------------------------------------------------------------

interface EditorOps {
  editJsx: (oldJsx: string, newJsx: string) => void;
  deleteComp: (jsx: string) => void;
  moveComp: (jsx: string, toBlockIndex: number) => void;
  resizeComp: (jsx: string, width?: string, height?: string) => void;
}

const EditorOpsContext = createContext<EditorOps | null>(null);

// ---------------------------------------------------------------------------
// ComponentBlock — name bar + live app (Rule 2)
// ---------------------------------------------------------------------------

function ComponentBlock({
  name,
  jsxSource,
  children,
}: {
  name: string;
  jsxSource: string;
  children: React.ReactNode;
}) {
  const ops = useContext(EditorOpsContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(jsxSource);
  const popoverRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editing) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setEditing(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [editing]);

  // Resize handle
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const startW = wrapper.offsetWidth;
    const startH = wrapper.offsetHeight;

    const onMove = (ev: MouseEvent) => {
      const w = Math.max(100, startW + (ev.clientX - startX));
      const h = Math.max(50, startH + (ev.clientY - startY));
      wrapper.style.width = w + "px";
      wrapper.style.height = h + "px";
    };

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const w = Math.max(100, startW + (ev.clientX - startX));
      const h = Math.max(50, startH + (ev.clientY - startY));
      ops?.resizeComp(jsxSource, w + "px", h + "px");
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [jsxSource, ops]);

  return (
    <div ref={wrapperRef} className={styles.componentWrapper}>
      <div
        className={styles.componentBar}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-adiabatic-jsx", jsxSource);
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        <span className={styles.componentName}>{name}</span>
        <button
          className={styles.componentBarBtn}
          onClick={() => { setDraft(jsxSource); setEditing(true); }}
        >Edit</button>
        <button
          className={styles.componentDeleteBtn}
          onClick={() => ops?.deleteComp(jsxSource)}
        >&times;</button>
      </div>
      <div className={styles.componentBody}>{children}</div>
      {/* Resize handle */}
      <div
        className={styles.resizeHandle}
        onMouseDown={handleResizeStart}
      />
      {editing && (
        <div ref={popoverRef} className={styles.popover} onMouseDown={(e) => e.stopPropagation()}>
          <textarea
            className={styles.popoverTextarea}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.max(3, draft.split("\n").length + 1)}
            autoFocus
          />
          <div className={styles.popoverActions}>
            <button className={styles.popoverSave} onClick={() => { ops?.editJsx(jsxSource, draft); setEditing(false); }}>Save</button>
            <button className={styles.popoverCancel} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MdxLink — Cmd+click to follow, regular click bubbles to block handler
// ---------------------------------------------------------------------------

function MdxLink({ href, children, ...props }: any) {
  const normalized = normalizeHref(href || "");
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(normalized, "_blank", "noopener,noreferrer");
  };
  return <a href={normalized} onClick={handleClick} {...props}>{children}</a>;
}

// ---------------------------------------------------------------------------
// Compile full document + resolve app components
// ---------------------------------------------------------------------------

interface CompileResult {
  MdxComponent: React.ComponentType<{ components?: Record<string, any> }> | null;
  appComponents: Record<string, React.ComponentType<any>>;
  error: string | null;
  fullApp: boolean;
}

async function resolveAppComponents(
  mdx: string,
  options?: { fullApp?: boolean },
): Promise<Record<string, React.ComponentType<any>>> {
  const imports = extractImports(mdx);
  const components: Record<string, React.ComponentType<any>> = {};

  const byApp = new Map<string, string[]>();
  for (const { name, appId } of imports) {
    const names = byApp.get(appId) ?? [];
    names.push(name);
    byApp.set(appId, names);
  }

  await Promise.all(
    Array.from(byApp.entries()).map(async ([appId, names]) => {
      try {
        const mod = await appModuleLoader(appId, "index.tsx");
        const system = createSystemBridge(appId);

        for (const name of names) {
          const Component = mod[name] as React.ComponentType<any> | undefined;
          if (!Component) continue;

          if (options?.fullApp) {
            const FullAppWrapped = (props: any) => (
              <ErrorBoundary>
                <Component {...props} system={system} />
              </ErrorBoundary>
            );
            FullAppWrapped.displayName = name;
            components[name] = FullAppWrapped;
          } else {
            const usages = extractComponentJsx(mdx, name);
            let counter = 0;

            const Wrapped = (props: any) => {
              // eslint-disable-next-line react-hooks/rules-of-hooks
              const idxRef = useRef(-1);
              if (idxRef.current === -1) {
                idxRef.current = counter++;
              }
              const jsxSource = usages[idxRef.current] ?? `<${name} />`;
              return (
                <ComponentBlock name={name} jsxSource={jsxSource}>
                  <ErrorBoundary>
                    <Component {...props} system={system} />
                  </ErrorBoundary>
                </ComponentBlock>
              );
            };
            Wrapped.displayName = name;
            components[name] = Wrapped;
          }
        }
      } catch (err) {
        console.error(`[MdxRenderer] Failed to load app "${appId}":`, err);
      }
    }),
  );
  return components;
}

async function compileMdx(content: string): Promise<CompileResult> {
  try {
    // Detect full-app: only imports + exactly one component block
    const cBlocks = getBlocks(content);
    const classified = cBlocks.map(classifyBlock);
    const compCount = classified.filter((c) => c === "component").length;
    const textCount = classified.filter((c) => c === "text").length;
    const fullApp = compCount === 1 && textCount === 0;

    const appComponents = await resolveAppComponents(content, { fullApp });
    const stripped = stripAppImports(content);
    const result = await renderMdx(stripped);

    if ("error" in result && result.error) {
      return { MdxComponent: null, appComponents: {}, error: result.error, fullApp: false };
    }
    if (!("code" in result) || !result.code) {
      return { MdxComponent: null, appComponents: {}, error: "No compiled code", fullApp: false };
    }

    const mod = await run(result.code, {
      ...jsxRuntime,
      baseUrl: import.meta.url,
    });

    return { MdxComponent: mod.default, appComponents, error: null, fullApp };
  } catch (err) {
    return {
      MdxComponent: null,
      appComponents: {},
      error: err instanceof Error ? err.message : String(err),
      fullApp: false,
    };
  }
}

// ---------------------------------------------------------------------------
// MdxRenderer (main component)
// ---------------------------------------------------------------------------

export function MdxRenderer({ content, onSave }: MdxRendererProps) {
  const [compiled, setCompiled] = useState<CompileResult | null>(null);
  const [compiling, setCompiling] = useState(true);

  const sourceRef = useRef(content);
  const lastSavedRef = useRef(content);
  const versionRef = useRef(0);
  const contentRef = useRef<HTMLDivElement>(null);

  // Editing state: which block is being edited, where to overlay the editor
  const [editingBlock, setEditingBlock] = useState<EditingState | null>(null);

  const [dropIndicator, setDropIndicator] = useState<{
    blockIdx: number;
    y: number;
  } | null>(null);
  const dropIndicatorRef = useRef<HTMLDivElement>(null);

  // Slash command state
  const [slashState, setSlashState] = useState<{
    filter: string;
    position: { x: number; y: number };
    blockIdx: number;
  } | null>(null);

  // Apps for slash commands
  const { apps } = useApps();
  const slashItems = useMemo<SlashItem[]>(() => {
    const items: SlashItem[] = [];
    for (const app of apps) {
      for (const comp of app.components) {
        items.push({ appId: app.id, appName: app.name, componentName: comp });
      }
    }
    return items;
  }, [apps]);

  // Undo / Redo stacks
  const undoStackRef = useRef<string[]>([]);
  const redoStackRef = useRef<string[]>([]);

  // Blocks analysis
  const blocks = useMemo(() => getBlocks(sourceRef.current), [compiled, editingBlock]);

  // Build line number → block index map for source-position-based matching
  const lineToBlock = useMemo(() => {
    const map = new Map<number, number>();
    const src = sourceRef.current;
    let searchFrom = 0;
    for (let i = 0; i < blocks.length; i++) {
      const pos = src.indexOf(blocks[i], searchFrom);
      if (pos === -1) continue;
      const startLine = src.slice(0, pos).split("\n").length;
      const lineCount = blocks[i].split("\n").length;
      for (let l = startLine; l < startLine + lineCount; l++) {
        map.set(l, i);
      }
      searchFrom = pos + blocks[i].length;
    }
    return map;
  }, [blocks]);

  // --- Compile ---
  const compile = useCallback((src: string) => {
    const version = ++versionRef.current;
    setCompiling(true);
    compileMdx(src).then((result) => {
      if (version !== versionRef.current) return;
      setCompiled(result);
      setCompiling(false);
    });
  }, []);

  // Initial compile
  useEffect(() => { compile(content); }, []); // eslint-disable-line

  // Recompile on external changes
  useEffect(() => {
    if (content === lastSavedRef.current) return;
    sourceRef.current = content;
    lastSavedRef.current = content;
    compile(content);
  }, [content, compile]);

  // --- Save helper ---
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = useCallback(
    (newSource: string) => {
      // Push current state to undo stack
      undoStackRef.current.push(sourceRef.current);
      if (undoStackRef.current.length > 50) undoStackRef.current.shift();
      redoStackRef.current = [];

      sourceRef.current = newSource;
      lastSavedRef.current = newSource;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => onSave(newSource), 300);
      compile(newSource);
    },
    [onSave, compile],
  );

  // --- Undo / Redo ---
  const applySource = useCallback((src: string) => {
    sourceRef.current = src;
    lastSavedRef.current = src;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => onSave(src), 300);
    compile(src);
  }, [onSave, compile]);

  const undo = useCallback(() => {
    if (editingBlock) return;
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    redoStackRef.current.push(sourceRef.current);
    applySource(stack.pop()!);
  }, [applySource, editingBlock]);

  const redo = useCallback(() => {
    if (editingBlock) return;
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    undoStackRef.current.push(sourceRef.current);
    applySource(stack.pop()!);
  }, [applySource, editingBlock]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (editingBlock) return; // Monaco handles its own undo
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [undo, redo, editingBlock]);

  // --- Editor operations (for ComponentBlock via context) ---
  const editorOps = useMemo<EditorOps>(() => ({
    editJsx: (oldJsx, newJsx) => {
      save(editComponentJsx(sourceRef.current, oldJsx, newJsx));
    },
    deleteComp: (jsx) => {
      save(deleteComponent(sourceRef.current, jsx));
    },
    moveComp: (jsx, toBlockIndex) => {
      save(moveComponent(sourceRef.current, jsx, toBlockIndex));
    },
    resizeComp: (jsx, width, height) => {
      save(resizeComponent(sourceRef.current, jsx, width, height));
    },
  }), [save]);

  // --- Click handler: find which block was clicked, enter edit mode ---
  const handleContentClick = useCallback((e: React.MouseEvent) => {
    if (editingBlock) return; // already editing

    const container = contentRef.current;
    if (!container) return;

    // Don't intercept clicks on component wrappers
    if ((e.target as HTMLElement).closest?.(`.${styles.componentWrapper}`)) return;

    // Find direct child of container that contains click target
    let target = e.target as HTMLElement;
    while (target && target.parentElement !== container) {
      if (target === container) break;
      target = target.parentElement as HTMLElement;
    }

    // Handle bare text nodes (MDX expressions like {1+4})
    if (target === container) {
      const caret = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (!caret) return;
      let textNode: Node | null = caret.startContainer;
      if (textNode.nodeType !== Node.TEXT_NODE) return;
      if (textNode.parentNode !== container) return;
      if (!textNode.textContent?.trim()) return;

      // Find block index from surrounding annotated siblings
      let prevLine = 0;
      let prev = textNode.previousSibling;
      while (prev) {
        if (prev instanceof HTMLElement) {
          const sl = prev.getAttribute("data-source-line");
          if (sl) { prevLine = parseInt(sl, 10); break; }
        }
        prev = prev.previousSibling;
      }
      const sortedLines = Array.from(lineToBlock.keys()).sort((a, b) => a - b);
      let blockIdx: number | undefined;
      for (const line of sortedLines) {
        if (line > prevLine) {
          blockIdx = lineToBlock.get(line);
          break;
        }
      }
      if (blockIdx === undefined) return;
      if (classifyBlock(blocks[blockIdx]) !== "text") return;

      // Get bounding rect of the text node
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const textRect = range.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();

      setEditingBlock({
        blockIdx,
        source: blocks[blockIdx],
        rect: {
          top: textRect.top - containerRect.top + container.scrollTop,
          left: textRect.left - containerRect.left,
          width: containerRect.width,
          height: Math.max(textRect.height, 26),
        },
        hiddenEl: null, // no element to hide for bare text nodes
      });
      return;
    }

    if (!target || target.parentElement !== container) return;

    // Use data-source-line attribute (from rehype plugin) to find the block
    const sourceLine = parseInt(
      target.getAttribute("data-source-line") || "0",
      10,
    );
    if (!sourceLine) return;

    const blockIdx = lineToBlock.get(sourceLine);
    if (blockIdx === undefined) return;
    if (classifyBlock(blocks[blockIdx]) === "component") return;
    if (classifyBlock(blocks[blockIdx]) === "import") return;

    // Record the element's position relative to the container
    const targetRect = target.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    // Hide the rendered element and show Monaco overlay
    target.style.visibility = "hidden";

    setEditingBlock({
      blockIdx,
      source: blocks[blockIdx],
      rect: {
        top: targetRect.top - containerRect.top + container.scrollTop,
        left: targetRect.left - containerRect.left,
        width: targetRect.width,
        height: Math.max(targetRect.height, 26),
      },
      hiddenEl: target,
    });
  }, [editingBlock, blocks, lineToBlock]);

  // --- Restore hidden element when editing ends ---
  const finishEditing = useCallback(() => {
    if (editingBlock?.hiddenEl) {
      editingBlock.hiddenEl.style.visibility = "";
    }
    setEditingBlock(null);
    setSlashState(null);
  }, [editingBlock]);

  // --- Save from inline editor ---
  const handleInlineSave = useCallback((newText: string) => {
    const editing = editingBlock;
    if (!editing) return;

    // Restore hidden element before recompile
    if (editing.hiddenEl) {
      editing.hiddenEl.style.visibility = "";
    }
    setEditingBlock(null);
    setSlashState(null);

    if (newText.trim()) {
      if (editing.blockIdx >= blocks.length) {
        // New block appended at the end (tail zone / empty doc)
        const src = sourceRef.current.trim();
        const newSource = src ? src + "\n\n" + newText : newText;
        save(newSource);
      } else if (newText !== blocks[editing.blockIdx]) {
        save(replaceBlock(sourceRef.current, editing.blockIdx, newText));
      }
    }
  }, [editingBlock, blocks, save]);

  // --- Cancel from inline editor ---
  const handleInlineCancel = useCallback(() => {
    finishEditing();
  }, [finishEditing]);

  // --- Slash detection from inline editor ---
  const handleInlineSlash = useCallback((filter: string, position: { x: number; y: number }) => {
    if (!filter && position.x === 0 && position.y === 0) {
      setSlashState(null);
      return;
    }
    if (editingBlock) {
      setSlashState({ filter, position, blockIdx: editingBlock.blockIdx });
    }
  }, [editingBlock]);

  // --- Drag & Drop handlers ---
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("application/x-adiabatic-jsx")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    const container = contentRef.current;
    if (!container) return;

    // Find the closest block boundary
    const children = Array.from(container.children) as HTMLElement[];
    const containerRect = container.getBoundingClientRect();
    const mouseY = e.clientY;

    let bestIdx = blocks.length; // default: end
    let bestY = containerRect.bottom;

    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (mouseY < midY) {
        const sourceLine = parseInt(children[i].getAttribute("data-source-line") || "0", 10);
        const blockIdx = sourceLine ? lineToBlock.get(sourceLine) : undefined;
        if (blockIdx !== undefined) {
          bestIdx = blockIdx;
          bestY = rect.top;
        }
        break;
      }
      if (i === children.length - 1) {
        const sourceLine = parseInt(children[i].getAttribute("data-source-line") || "0", 10);
        const blockIdx = sourceLine ? lineToBlock.get(sourceLine) : undefined;
        if (blockIdx !== undefined) {
          bestIdx = blockIdx + 1;
          bestY = rect.bottom;
        }
      }
    }

    setDropIndicator({ blockIdx: bestIdx, y: bestY - containerRect.top });
  }, [blocks, lineToBlock]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const container = contentRef.current;
    if (!container) return;
    if (!container.contains(e.relatedTarget as Node)) {
      setDropIndicator(null);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const jsx = e.dataTransfer.getData("application/x-adiabatic-jsx");
    if (!jsx || dropIndicator === null) {
      setDropIndicator(null);
      return;
    }
    editorOps.moveComp(jsx, dropIndicator.blockIdx);
    setDropIndicator(null);
  }, [editorOps, dropIndicator]);

  // --- Slash command: select handler ---
  const handleSlashSelect = useCallback((item: SlashItem) => {
    setSlashState(null);

    // Dismiss the inline editor without saving
    if (editingBlock?.hiddenEl) {
      editingBlock.hiddenEl.style.visibility = "";
    }
    const blockIdx = editingBlock?.blockIdx ?? blocks.length;
    setEditingBlock(null);

    const componentJsx = `<${item.componentName} />`;
    let src = sourceRef.current;
    src = insertComponent(src, componentJsx, blockIdx);
    src = ensureImport(src, item.componentName, item.appId);
    save(src);
  }, [save, editingBlock, blocks]);

  // --- Components for MDX ---
  const allComponents = useMemo(
    () => ({
      a: MdxLink,
      ...(compiled?.appComponents || {}),
    }),
    [compiled?.appComponents],
  );

  // --- Click below content → append new line & enter edit ---
  const handleTailClick = useCallback(() => {
    if (editingBlock) return;
    const container = contentRef.current;
    if (!container) return;

    const tailZone = container.querySelector(`.${styles.tailZone}`);
    const containerRect = container.getBoundingClientRect();
    const tailRect = tailZone?.getBoundingClientRect();

    const blockIdx = getBlocks(sourceRef.current).length;

    setEditingBlock({
      blockIdx,
      source: "",
      rect: {
        top: tailRect
          ? tailRect.top - containerRect.top + container.scrollTop
          : containerRect.height,
        left: 0,
        width: containerRect.width - 96, // account for padding
        height: 26,
      },
      hiddenEl: null,
    });
  }, [editingBlock]);

  // --- Empty doc: editable area ---
  const handleEmptyClick = useCallback(() => {
    if (editingBlock) return;

    setEditingBlock({
      blockIdx: 0,
      source: "",
      rect: {
        top: 32,
        left: 0,
        width: 800,
        height: 26,
      },
      hiddenEl: null,
    });
  }, [editingBlock]);

  // --- Render ---
  if (compiling && !compiled) {
    return <div className={styles.loading}>Compiling...</div>;
  }

  const isEmpty = !sourceRef.current.trim();

  return (
    <div className={styles.renderer}>
      {compiled?.error && (
        <div className={styles.error}>
          <strong>MDX Error</strong>
          <pre>{compiled.error}</pre>
        </div>
      )}
      {compiled?.fullApp && compiled?.MdxComponent ? (
        <div className={styles.contentFullApp}>
          <ErrorBoundary>
            <compiled.MdxComponent components={allComponents} />
          </ErrorBoundary>
        </div>
      ) : compiled?.MdxComponent ? (
        <EditorOpsContext.Provider value={editorOps}>
          <div
            ref={contentRef}
            className={styles.content}
            onClick={handleContentClick}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            style={{ position: "relative" }}
          >
            <ErrorBoundary resetKey={compiled}>
              <compiled.MdxComponent components={allComponents} />
            </ErrorBoundary>
            {/* Inline Monaco editor overlay */}
            {editingBlock && (
              <div
                className={styles.inlineEditor}
                style={{
                  position: "absolute",
                  top: editingBlock.rect.top,
                  left: editingBlock.rect.left,
                  width: editingBlock.rect.width,
                  zIndex: 50,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <InlineBlockEditor
                  source={editingBlock.source}
                  onSave={handleInlineSave}
                  onCancel={handleInlineCancel}
                  onSlash={handleInlineSlash}
                />
              </div>
            )}
            {/* Clickable tail area below content — append new block */}
            <div
              className={styles.tailZone}
              onClick={(e) => { e.stopPropagation(); handleTailClick(); }}
            />
            {dropIndicator && (
              <div
                ref={dropIndicatorRef}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: dropIndicator.y,
                  height: 3,
                  background: "var(--color-accent, #007acc)",
                  borderRadius: 2,
                  pointerEvents: "none",
                  zIndex: 100,
                  transition: "top 0.1s ease",
                }}
              />
            )}
          </div>
        </EditorOpsContext.Provider>
      ) : isEmpty ? (
        <div
          ref={contentRef}
          className={styles.content}
          onClick={handleEmptyClick}
          style={{ cursor: "text", position: "relative" }}
        >
          <p style={{ color: "rgba(0,0,0,0.3)", margin: 0 }}>Click to start writing...</p>
          {editingBlock && (
            <div
              className={styles.inlineEditor}
              style={{
                position: "absolute",
                top: editingBlock.rect.top,
                left: editingBlock.rect.left,
                width: editingBlock.rect.width,
                zIndex: 50,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <InlineBlockEditor
                source={editingBlock.source}
                onSave={handleInlineSave}
                onCancel={handleInlineCancel}
                onSlash={handleInlineSlash}
              />
            </div>
          )}
        </div>
      ) : compiled?.error ? (
        <pre className={styles.content} style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", fontSize: "13px" }}>
          {sourceRef.current}
        </pre>
      ) : null}
      {slashState && (
        <SlashPalette
          items={slashItems}
          filter={slashState.filter}
          position={slashState.position}
          onSelect={handleSlashSelect}
          onClose={() => setSlashState(null)}
        />
      )}
    </div>
  );
}
