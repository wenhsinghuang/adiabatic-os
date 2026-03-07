// MdxRenderer — compiles MDX via the core API, executes the compiled code,
// and renders the result with inline text editing and component popovers.

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  createContext,
  useContext,
  type ReactNode,
} from "react";
import { run } from "@mdx-js/mdx";
import * as jsxRuntime from "react/jsx-runtime";
import { renderMdx } from "../lib/api";
import { appModuleLoader } from "../sandbox/app-bundler";
import { createSystemBridge } from "../sandbox/system-bridge";
import { ErrorBoundary } from "../components/ErrorBoundary";
import styles from "./MdxRenderer.module.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MdxRendererProps {
  content: string;
  onSave: (content: string) => void;
}

interface EditContextValue {
  /** Patch source for inline text edits (no recompile — DOM already reflects change). */
  patchText: (oldFragment: string, newFragment: string) => void;
  /** Patch source for component/JSX edits (triggers recompile). */
  patchComponent: (oldFragment: string, newFragment: string) => void;
}

// ---------------------------------------------------------------------------
// Edit context
// ---------------------------------------------------------------------------

const EditContext = createContext<EditContextValue | null>(null);

// ---------------------------------------------------------------------------
// DOM → Markdown conversion (for contentEditable output)
// ---------------------------------------------------------------------------

function domToMd(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const inner = Array.from(el.childNodes).map(domToMd).join("");
  switch (el.tagName.toLowerCase()) {
    case "strong":
    case "b":
      return `**${inner}**`;
    case "em":
    case "i":
      return `_${inner}_`;
    case "code":
      return `\`${inner}\``;
    case "del":
    case "s":
      return `~~${inner}~~`;
    case "a":
      return `[${inner}](${el.getAttribute("href") ?? ""})`;
    case "br":
      return "\n";
    default:
      return inner;
  }
}

// ---------------------------------------------------------------------------
// EditableBlock — contentEditable wrapper for text elements (h1-h3, p, li)
// ---------------------------------------------------------------------------

function EditableBlock({
  tag,
  children,
  ...rest
}: {
  tag: string;
  children?: ReactNode;
  [k: string]: unknown;
}) {
  const ctx = useContext(EditContext);
  const ref = useRef<HTMLElement>(null);
  const initialMdRef = useRef<string | null>(null);

  // Capture the initial markdown on first mount
  useEffect(() => {
    if (ref.current && initialMdRef.current === null) {
      initialMdRef.current = domToMd(ref.current);
    }
  });

  const handleBlur = useCallback(() => {
    if (!ctx || !ref.current || initialMdRef.current === null) return;
    const newMd = domToMd(ref.current);
    if (newMd === initialMdRef.current) return;

    // Build full source fragment (headings need their # prefix)
    const level = tag.match(/^h(\d)$/)?.[1];
    const prefix = level ? "#".repeat(Number(level)) + " " : "";
    const oldLine = prefix + initialMdRef.current;
    const newLine = prefix + newMd;

    ctx.patchText(oldLine, newLine);
    initialMdRef.current = newMd;
  }, [ctx, tag]);

  // Dynamic tag — use createElement to avoid TS union type explosion
  return (
    (React as any).createElement(
      tag,
      {
        ref,
        contentEditable: true,
        suppressContentEditableWarning: true,
        onBlur: handleBlur,
        style: { outline: "none" },
        ...rest,
      },
      children,
    )
  );
}

// ---------------------------------------------------------------------------
// LinkElement — floating URL popover on click (edit / open)
// ---------------------------------------------------------------------------

function LinkElement({
  href,
  children,
  ...rest
}: {
  href?: string;
  children?: ReactNode;
  [k: string]: unknown;
}) {
  const ctx = useContext(EditContext);
  const [showPopover, setShowPopover] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(href ?? "");
  const linkRef = useRef<HTMLAnchorElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!showPopover) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        linkRef.current &&
        !linkRef.current.contains(e.target as Node)
      ) {
        setShowPopover(false);
        setEditing(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showPopover]);

  const commitUrl = () => {
    if (ctx && href !== undefined) {
      // Rebuild markdown link text from children
      const text = linkRef.current?.textContent ?? "";
      ctx.patchText(`[${text}](${href})`, `[${text}](${draft})`);
    }
    setEditing(false);
  };

  return (
    <span style={{ position: "relative", display: "inline" }}>
      <a
        ref={linkRef}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          setDraft(href ?? "");
          setShowPopover(true);
        }}
        style={{ color: "var(--color-accent)", textDecoration: "none", cursor: "pointer" }}
        {...(rest as any)}
      >
        {children}
      </a>
      {showPopover && (
        <div
          ref={popoverRef}
          contentEditable={false}
          onMouseDown={(e) => e.stopPropagation()}
          className={styles.linkPopover}
        >
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitUrl();
                if (e.key === "Escape") {
                  setEditing(false);
                  setShowPopover(false);
                }
              }}
              className={styles.linkInput}
            />
          ) : (
            <span className={styles.linkUrl}>{href || "No URL"}</span>
          )}
          {editing ? (
            <button
              onMouseDown={(e) => { e.preventDefault(); commitUrl(); }}
              className={styles.linkSaveBtn}
            >
              Save
            </button>
          ) : (
            <>
              <button
                onMouseDown={(e) => { e.preventDefault(); setEditing(true); }}
                className={styles.linkBtn}
                title="Edit URL"
              >
                Edit
              </button>
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (href) window.open(href, "_blank", "noopener,noreferrer");
                }}
                className={styles.linkOpenBtn}
                title="Open in new tab"
              >
                Open
              </button>
            </>
          )}
        </div>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ExpressionInline — Obsidian-style: click rendered value → edit source in-place
// ---------------------------------------------------------------------------

function ExpressionInline({
  source,
  children,
}: {
  source: string;
  children?: ReactNode;
}) {
  const ctx = useContext(EditContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(`{${source}}`);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleBlur = () => {
    if (!ctx) return;
    const newExpr = draft.trim();
    const oldExpr = `{${source}}`;
    if (newExpr && newExpr !== oldExpr) {
      ctx.patchComponent(oldExpr, newExpr);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <span className={styles.exprEditing}>
        <input
          ref={inputRef}
          className={styles.exprInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") inputRef.current?.blur();
            if (e.key === "Escape") {
              setDraft(`{${source}}`);
              setEditing(false);
            }
          }}
        />
      </span>
    );
  }

  return (
    <span
      className={styles.exprValue}
      onClick={() => {
        setDraft(`{${source}}`);
        setEditing(true);
      }}
      title={`Expression: {${source}}`}
    >
      {children}
    </span>
  );
}

// Map of standard markdown elements → editable wrappers
const editableComponents: Record<string, React.ComponentType<any>> = {
  h1: (props: any) => <EditableBlock tag="h1" {...props} />,
  h2: (props: any) => <EditableBlock tag="h2" {...props} />,
  h3: (props: any) => <EditableBlock tag="h3" {...props} />,
  p: (props: any) => <EditableBlock tag="p" {...props} />,
  li: (props: any) => <EditableBlock tag="li" {...props} />,
  a: (props: any) => <LinkElement {...props} />,
  mdxexpr: (props: any) => <ExpressionInline {...props} />,
};

// ---------------------------------------------------------------------------
// ComponentBlock — bar with name + edit/delete; component stays interactive
// ---------------------------------------------------------------------------

function ComponentBlock({
  name,
  jsxSource,
  children,
}: {
  name: string;
  jsxSource: string;
  children: ReactNode;
}) {
  const ctx = useContext(EditContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(jsxSource);
  const popoverRef = useRef<HTMLDivElement>(null);

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

  const handleSave = () => {
    if (!ctx) return;
    ctx.patchComponent(jsxSource, draft);
    setEditing(false);
  };

  const handleDelete = () => {
    if (!ctx) return;
    // Remove the component JSX (replace with empty, clean up the line)
    ctx.patchComponent(jsxSource, "");
  };

  return (
    <div className={styles.componentWrapper}>
      {/* Top bar — only visible on hover */}
      <div className={styles.componentBar}>
        <span className={styles.componentName}>{name}</span>
        <button
          className={styles.componentBarBtn}
          onClick={() => { setDraft(jsxSource); setEditing(true); }}
          title="Edit JSX"
        >
          Edit
        </button>
        <button
          className={styles.componentDeleteBtn}
          onClick={handleDelete}
          title="Delete component"
        >
          &times;
        </button>
      </div>
      {/* Component renders here — fully interactive */}
      <div className={styles.componentBody}>{children}</div>
      {/* Popover for editing JSX */}
      {editing && (
        <div
          ref={popoverRef}
          className={styles.popover}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <textarea
            className={styles.popoverTextarea}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.max(3, draft.split("\n").length + 1)}
            autoFocus
          />
          <div className={styles.popoverActions}>
            <button className={styles.popoverSave} onClick={handleSave}>
              Save
            </button>
            <button
              className={styles.popoverCancel}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import extraction / stripping
// ---------------------------------------------------------------------------

function extractImports(
  mdx: string,
): { name: string; appId: string }[] {
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
    /^import\s*\{[^}]+\}\s*from\s*['"]@apps\/[^'"]+['"]\s*;?\s*$/gm,
    "",
  );
}

// Wrap standalone flow expressions ({expr} on their own line) with <mdxexpr>
// so they become clickable/editable via the components prop.
// Uses lowercase tag name so MDX resolves it through _components.
function wrapExpressions(mdx: string): string {
  const lines = mdx.split("\n");
  let inCodeBlock = false;
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        return line;
      }
      if (inCodeBlock) return line;
      // Skip escaped expressions
      if (trimmed.startsWith("\\{")) return line;
      // Match standalone expressions: {expr} on their own line
      const match = trimmed.match(/^\{(.+)\}$/);
      if (match && !trimmed.startsWith("{/*")) {
        const expr = match[1];
        const encoded = JSON.stringify(expr);
        return `<mdxexpr source={${encoded}}>{${expr}}</mdxexpr>`;
      }
      return line;
    })
    .join("\n");
}

// Extract all JSX usages of a named component, in source order.
function extractComponentJsx(mdx: string, name: string): string[] {
  const usages: { text: string; index: number }[] = [];
  // Self-closing: <Name ... />
  const re1 = new RegExp(`<${name}\\b[^>]*?\\/>`, "g");
  let m;
  while ((m = re1.exec(mdx)) !== null) {
    usages.push({ text: m[0], index: m.index });
  }
  // Opening+closing: <Name ...>...</Name>
  const re2 = new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}>`, "g");
  while ((m = re2.exec(mdx)) !== null) {
    // Avoid double-counting self-closing matches
    if (!usages.some((u) => u.index === m!.index)) {
      usages.push({ text: m[0], index: m.index });
    }
  }
  usages.sort((a, b) => a.index - b.index);
  return usages.map((u) => u.text);
}

// ---------------------------------------------------------------------------
// Resolve app components (with popover wrappers)
// ---------------------------------------------------------------------------

async function resolveAppComponents(
  mdx: string,
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
      } catch (err) {
        console.error(`[MdxRenderer] Failed to load app "${appId}":`, err);
      }
    }),
  );

  return components;
}

// ---------------------------------------------------------------------------
// Compile MDX
// ---------------------------------------------------------------------------

interface CompileResult {
  MdxComponent: React.ComponentType<{
    components?: Record<string, any>;
  }> | null;
  appComponents: Record<string, React.ComponentType<any>>;
  error: string | null;
}

async function compileMdx(content: string): Promise<CompileResult> {
  try {
    const appComponents = await resolveAppComponents(content);
    const stripped = stripAppImports(content);
    const withExprs = wrapExpressions(stripped);
    const result = await renderMdx(withExprs);

    if ("error" in result && result.error) {
      return { MdxComponent: null, appComponents: {}, error: result.error };
    }
    if (!("code" in result) || !result.code) {
      return {
        MdxComponent: null,
        appComponents: {},
        error: "No compiled code returned",
      };
    }

    const mod = await run(result.code, {
      ...jsxRuntime,
      baseUrl: import.meta.url,
    });

    return { MdxComponent: mod.default, appComponents, error: null };
  } catch (err) {
    return {
      MdxComponent: null,
      appComponents: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// MdxRenderer (main component)
// ---------------------------------------------------------------------------

export function MdxRenderer({ content, onSave }: MdxRendererProps) {
  const [compiled, setCompiled] = useState<{
    MdxComponent: React.ComponentType<{ components?: Record<string, any> }>;
    appComponents: Record<string, React.ComponentType<any>>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(true);

  // Source tracking — keeps the "live" source that may diverge from the
  // content prop during inline edits (which don't trigger recompilation).
  const sourceRef = useRef(content);
  const lastSavedRef = useRef(content);
  const versionRef = useRef(0);

  const compile = useCallback((src: string) => {
    const version = ++versionRef.current;
    setCompiling(true);
    setError(null);

    compileMdx(src).then(({ MdxComponent, appComponents, error }) => {
      if (version !== versionRef.current) return;
      setCompiling(false);
      if (error) {
        setError(error);
      } else if (MdxComponent) {
        setCompiled({ MdxComponent, appComponents });
        setError(null);
      }
    });
  }, []);

  // Initial compile
  useEffect(() => {
    compile(content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recompile on external content changes (not from our own saves)
  useEffect(() => {
    if (content === lastSavedRef.current) return;
    sourceRef.current = content;
    lastSavedRef.current = content;
    compile(content);
  }, [content, compile]);

  // --- Patch helpers ---

  const patchSource = useCallback(
    (oldFragment: string, newFragment: string): string | null => {
      const src = sourceRef.current;
      const idx = src.indexOf(oldFragment);
      if (idx === -1) {
        console.warn("[MdxRenderer] patch: fragment not found:", oldFragment);
        return null;
      }
      const patched =
        src.slice(0, idx) + newFragment + src.slice(idx + oldFragment.length);
      sourceRef.current = patched;
      lastSavedRef.current = patched;
      onSave(patched);
      return patched;
    },
    [onSave],
  );

  // Text edits: patch source, NO recompile (DOM already shows the change)
  const patchText = useCallback(
    (oldFragment: string, newFragment: string) => {
      patchSource(oldFragment, newFragment);
    },
    [patchSource],
  );

  // Component edits: patch source AND recompile to re-render component
  const patchComponent = useCallback(
    (oldFragment: string, newFragment: string) => {
      const patched = patchSource(oldFragment, newFragment);
      if (patched) compile(patched);
    },
    [patchSource, compile],
  );

  const editCtx = useMemo(
    () => ({ patchText, patchComponent }),
    [patchText, patchComponent],
  );

  // --- Render ---

  if (compiling && !compiled) {
    return <div className={styles.loading}>Compiling...</div>;
  }

  const allComponents = compiled
    ? { ...editableComponents, ...compiled.appComponents }
    : editableComponents;

  return (
    <div className={styles.renderer}>
      {error && (
        <div className={styles.error}>
          <strong>MDX Error</strong>
          <pre>{error}</pre>
        </div>
      )}
      {compiled && (
        <EditContext.Provider value={editCtx}>
          <div className={styles.content}>
            <ErrorBoundary>
              <compiled.MdxComponent components={allComponents} />
            </ErrorBoundary>
          </div>
        </EditContext.Provider>
      )}
    </div>
  );
}
