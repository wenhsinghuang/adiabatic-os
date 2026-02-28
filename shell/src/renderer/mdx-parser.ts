// MDX Parser — splits MDX content into segments of markdown text and component references.
//
// Input:  "# Title\n\nSome text.\n\n<FocusChart period=\"week\" />\n\nMore text."
// Output: [
//   { type: "markdown", content: "# Title\n\nSome text." },
//   { type: "component", name: "FocusChart", props: { period: "week" }, raw: "<FocusChart period=\"week\" />" },
//   { type: "markdown", content: "More text." },
// ]
//
// This is intentionally simple for D1. Handles:
// - Self-closing component tags: <Name prop="value" />
// - Opening+closing component tags: <Name prop="value">children</Name>
// - String, number, boolean props
// - Expression props: prop={expr} (kept as raw string)

export interface MarkdownSegment {
  type: "markdown";
  content: string;
}

export interface ComponentSegment {
  type: "component";
  name: string;
  props: Record<string, unknown>;
  children: string | null;
  raw: string;
}

export type MDXSegment = MarkdownSegment | ComponentSegment;

// Match top-level JSX component tags (PascalCase = user components, not HTML).
// Self-closing: <ComponentName prop="value" />
// With children: <ComponentName prop="value">...children...</ComponentName>
const SELF_CLOSING_RE =
  /^<([A-Z][A-Za-z0-9]*)((?:\s+[a-zA-Z_][\w]*(?:=(?:"[^"]*"|'[^']*'|\{[^}]*\}|[\w]+))?)*)\s*\/>\s*$/;

const OPEN_CLOSE_RE =
  /^<([A-Z][A-Za-z0-9]*)((?:\s+[a-zA-Z_][\w]*(?:=(?:"[^"]*"|'[^']*'|\{[^}]*\}|[\w]+))?)*)\s*>([\s\S]*?)<\/\1>\s*$/;

// Parse props string like: prop="value" count={42} enabled
const PROP_RE = /([a-zA-Z_][\w]*)(?:=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g;

function parseProps(propsStr: string): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  let match;
  PROP_RE.lastIndex = 0;
  while ((match = PROP_RE.exec(propsStr)) !== null) {
    const [, key, doubleQuoted, singleQuoted, expression] = match;
    if (doubleQuoted !== undefined) {
      props[key] = doubleQuoted;
    } else if (singleQuoted !== undefined) {
      props[key] = singleQuoted;
    } else if (expression !== undefined) {
      // Try to evaluate simple expressions: numbers, booleans, strings
      const trimmed = expression.trim();
      if (trimmed === "true") props[key] = true;
      else if (trimmed === "false") props[key] = false;
      else if (trimmed === "null") props[key] = null;
      else if (/^-?\d+(\.\d+)?$/.test(trimmed)) props[key] = Number(trimmed);
      else if (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed))
        props[key] = trimmed.slice(1, -1);
      else props[key] = trimmed; // keep as raw expression string
    } else {
      // Boolean shorthand: <Component enabled />
      props[key] = true;
    }
  }
  return props;
}

function tryParseComponent(line: string): ComponentSegment | null {
  const trimmed = line.trim();

  // Self-closing
  let match = trimmed.match(SELF_CLOSING_RE);
  if (match) {
    const [raw, name, propsStr] = match;
    return {
      type: "component",
      name,
      props: parseProps(propsStr || ""),
      children: null,
      raw,
    };
  }

  // Open + close
  match = trimmed.match(OPEN_CLOSE_RE);
  if (match) {
    const [raw, name, propsStr, children] = match;
    return {
      type: "component",
      name,
      props: parseProps(propsStr || ""),
      children: children.trim() || null,
      raw,
    };
  }

  return null;
}

// Parse MDX content into segments.
// Strategy: split by blank lines into paragraphs, then check if each paragraph
// is a component tag or markdown text.
export function parseMDX(mdx: string): MDXSegment[] {
  const segments: MDXSegment[] = [];
  const lines = mdx.split("\n");

  let markdownBuffer: string[] = [];

  function flushMarkdown(): void {
    if (markdownBuffer.length > 0) {
      const content = markdownBuffer.join("\n").trim();
      if (content) {
        segments.push({ type: "markdown", content });
      }
      markdownBuffer = [];
    }
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check if this line starts a component tag
    if (/^<[A-Z]/.test(trimmed)) {
      // Collect lines until we have a complete tag
      let tagLines = [line];
      let tagStr = trimmed;

      // Self-closing on single line?
      let component = tryParseComponent(tagStr);
      if (!component) {
        // Multi-line tag: collect until closing
        let j = i + 1;
        while (j < lines.length) {
          tagLines.push(lines[j]);
          tagStr = tagLines.map((l) => l.trim()).join("\n");
          component = tryParseComponent(tagStr);
          if (component) break;
          // Also check if self-closing ends on this line
          if (lines[j].trim().endsWith("/>")) {
            component = tryParseComponent(tagStr);
            if (component) break;
          }
          j++;
        }
        if (component) {
          i = j;
        }
      }

      if (component) {
        flushMarkdown();
        segments.push(component);
        i++;
        continue;
      }
    }

    // Regular markdown line
    markdownBuffer.push(line);
    i++;
  }

  flushMarkdown();
  return segments;
}

// Serialize segments back to MDX string.
export function serializeMDX(segments: MDXSegment[]): string {
  return segments
    .map((seg) => {
      if (seg.type === "markdown") return seg.content;
      return serializeComponent(seg);
    })
    .join("\n\n");
}

export function serializeComponent(seg: ComponentSegment): string {
  const propsStr = Object.entries(seg.props)
    .map(([key, value]) => {
      if (value === true) return key;
      if (typeof value === "string") return `${key}="${value}"`;
      return `${key}={${JSON.stringify(value)}}`;
    })
    .join(" ");

  const tag = propsStr ? `<${seg.name} ${propsStr}` : `<${seg.name}`;

  if (seg.children) {
    return `${tag}>\n${seg.children}\n</${seg.name}>`;
  }
  return `${tag} />`;
}
