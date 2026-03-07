# Renderer Architecture — MDX ↔ Plate.js Pipeline

This document defines how MDX content flows through the Plate.js editor. It exists to prevent the recurring "fix A breaks B" cycle.

話說 我對 renderer 要求其實蠻簡單的\                                                                                                    
    1. any  .mdx 只要是合法內容都該有能力 render\                                                                                           
    2. editor is WYSIWYG\                                                                                                                   
    3. editor 提供最基礎的 slash can didate, delete comp, resize, DnD 的功能 for react comp\                                               
    在這些要求的基礎上 沒任何 hidden state or implicit internal editor mechanism  

## Pipeline

```
MDX text
  ↓ remark-mdx parse
MDAST (mdxJsxFlowElement, mdxjsEsm, paragraph, heading, ...)
  ↓ remarkMdxToPlate transform (DESERIALIZE ONLY)
MDAST (mdxComponent, mdxImport, paragraph, heading, ...)
  ↓ Plate MarkdownPlugin rules (deserialize)
Slate nodes (mdx_component, mdx_import, h1, h2, p, ...)
  ↓ user edits in WYSIWYG editor
Slate nodes
  ↓ Plate MarkdownPlugin rules (serialize)
MDAST (mdxJsxFlowElement, mdxjsEsm, paragraph, heading, ...)
  ↓ remark-mdx stringify
MDX text
```

## Critical Invariant: remarkPlugins Direction

`MarkdownPlugin.remarkPlugins` run in **both** `deserializeMd` and `serializeMd`.

- `remarkMdx` — safe in both directions (adds MDX parse/stringify support)
- `remarkMdxToPlate` — **DESERIALIZE ONLY** (converts `mdxJsxFlowElement` → `mdxComponent`)

If `remarkMdxToPlate` runs during serialize, it converts `mdxJsxFlowElement` back to `mdxComponent` before stringify, which remark-stringify doesn't recognize. Result: content falls through as escaped text, `{` → `\{`, `<` → `\<`, compounding on each round-trip.

**Fix (PageRenderer.tsx):**
```ts
// MarkdownPlugin config — used for DESERIALIZE
remarkPlugins: [remarkMdx, remarkMdxToPlate]

// serializeMd call — override to EXCLUDE remarkMdxToPlate
serializeMd(editor, { value, remarkPlugins: [remarkMdx] })
```

**Rule: Never add a parse-only remark plugin to `MarkdownPlugin.remarkPlugins` without overriding `serializeMd`'s plugins.**

## MDX Component Lifecycle

### Types

| Context | Type | Shape |
|---|---|---|
| MDAST (from remark-mdx) | `mdxJsxFlowElement` | `{ name, attributes, children }` |
| MDAST (after remarkMdxToPlate) | `mdxComponent` | `{ name, attributes, width?, height? }` |
| Plate node | `mdx_component` | `{ name, attributes, width?, height?, children: [{text:""}] }` |
| MDAST (from serialize rule) | `mdxJsxFlowElement` | `{ name, attributes, children }` |

### Serialize Rules (mdx-component-plugin.tsx)

**Deserialize** (`mdxComponent` → `mdx_component`):
- Extracts `name`, `attributes`, `width`, `height`
- Width/height come from `remarkMdxToPlate` collapsing `<div style={{...}}>` wrappers

**Serialize** (`mdx_component` → `mdxJsxFlowElement`):
- If no width/height: emit `<Component attrs />` directly
- If width/height: wrap in `<div style={{width: "...", height: "..."}}>` (DD11: native JSX)

### MDX Import Lifecycle

| Context | Type |
|---|---|
| MDAST (from remark-mdx) | `mdxjsEsm` with `value: string` |
| MDAST (after remarkMdxToPlate) | `mdxImport` with `value: string` |
| Plate node | `mdx_import` with `value: string` |

Round-trips losslessly. Import text is stored as-is.

## Resize (DD11 Compliant)

Per DD11: all content operations are MDX changes. No hidden state.

- Editor stores `width`/`height` as Plate node properties
- **Serialized as native JSX**: `<div style={{width: "500px", height: "300px"}}><Component /></div>`
- **Deserialized** by `remarkMdxToPlate` collapsing the wrapper div back into the component node
- No custom `data-*` attributes — anyone reading the MDX understands the layout

### Wrapper Detection (remark-mdx-to-plate.ts)

A `<div>` is treated as a resize wrapper when:
1. It has a `style` attribute (expression value)
2. It contains exactly one JSX child element AND no other meaningful content (whitespace-only text nodes are ignored)

A div with mixed content (e.g. `<div style={{...}}>text<Component /></div>`) is NOT collapsed — it's treated as a regular JSX element.

Width/height are extracted from the style expression via regex.

## Drag and Drop

### Setup (PageRenderer.tsx)

- `DndPlugin` — provides DnD state management (no custom `render.aboveNodes` wrapper)
- `DndProvider` + `HTML5Backend` — react-dnd infrastructure
- `NodeIdPlugin` — assigns unique IDs to all elements (required for DnD tracking)

### How It Works

- **Component-only DnD**: only `mdx_component` void elements are draggable/droppable
- Components handle their own DnD via `useDraggable` in `MdxComponentElementUI`
- `useDraggable` wraps `useDndNode` which combines `useDragNode` + `useDropNode`
- Drop indicator (blue line) rendered via `useDropLine` reading `DndPlugin` state
- Text blocks (paragraphs, headings) are not draggable — use normal editing (cut/paste)

### Component DnD (mdx-component-plugin.tsx)

- Drag handle: entire component bar (hidden by default, shows on hover)
- `handleRef` from `useDraggable` → attached to component bar div
- `nodeRef` from `useDraggable` → attached to wrapper div (also the drop target)
- Visual feedback: `opacity: 0.5` during drag, blue drop line at top/bottom

## File Map

| File | Role |
|---|---|
| `shell/src/content/PageRenderer.tsx` | Editor setup, plugin config, serialize/deserialize |
| `shell/src/content/plugins/mdx-component-plugin.tsx` | Component void element, DnD, resize, serialize rules |
| `shell/src/content/plugins/mdx-import-plugin.tsx` | Import void element, serialize rules |
| `shell/src/content/plugins/remark-mdx-to-plate.ts` | MDAST type rewriting (parse-only), div wrapper collapsing |
| `shell/src/content/ComponentHost.tsx` | Live React component rendering in sandbox |
| `shell/src/content/PageRenderer.module.css` | Editor styles, DnD indicators, resize handle |

## Known Pitfalls

1. **remarkPlugins are shared** — any parse-only plugin in `MarkdownPlugin.remarkPlugins` will also run during serialize unless overridden in the `serializeMd` call
2. **Expression attribute values** — `style={{...}}` values are objects (`mdxJsxAttributeValueExpression`), not strings. They pass through Plate unchanged and remark-mdx handles them in both directions
3. **Void elements** need `children: [{ text: "" }]` in Plate — Slate requires at least one text child
4. **NodeIdPlugin** must have `normalizeInitialValue: true` — otherwise elements won't have IDs and DnD won't work
5. **DnD is component-only** — regular text blocks don't participate in DnD. Wrapping all blocks as drop targets via `render.aboveNodes` adds extra DOM divs and makes the editor feel heavy
6. **Wrapper detection must check ALL children** — checking only JSX children count is wrong; a div with `text + <Component />` would match and eat the text content
