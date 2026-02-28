// Sidebar — file tree from docs in DB.
// Doc IDs with path semantics (journal/today) are rendered as folders.

import { useDocs, type DocEntry } from "../hooks/useDocs";

interface SidebarProps {
  activeDocId: string | null;
  onSelect: (docId: string) => void;
}

interface TreeNode {
  name: string;
  docId?: string;
  children: Map<string, TreeNode>;
}

function buildTree(docs: DocEntry[]): TreeNode {
  const root: TreeNode = { name: "", children: new Map() };

  for (const doc of docs) {
    const parts = doc.id.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!current.children.has(part)) {
        current.children.set(part, { name: part, children: new Map() });
      }
      current = current.children.get(part)!;
      if (i === parts.length - 1) {
        current.docId = doc.id;
      }
    }
  }

  return root;
}

function TreeItem({
  node,
  depth,
  activeDocId,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  activeDocId: string | null;
  onSelect: (docId: string) => void;
}) {
  const isFolder = node.children.size > 0 && !node.docId;
  const isActive = node.docId === activeDocId;

  return (
    <>
      <div
        style={{
          padding: "4px 8px",
          paddingLeft: `${12 + depth * 16}px`,
          cursor: node.docId ? "pointer" : "default",
          backgroundColor: isActive ? "#e8f0fe" : "transparent",
          color: isActive ? "#1a73e8" : "#333",
          fontSize: "13px",
          borderRadius: "4px",
          margin: "1px 4px",
        }}
        onClick={() => node.docId && onSelect(node.docId)}
      >
        {isFolder ? "📁 " : "📄 "}
        {node.name}
      </div>
      {[...node.children.values()]
        .sort((a, b) => {
          // Folders first, then alphabetical
          const aIsFolder = a.children.size > 0 && !a.docId;
          const bIsFolder = b.children.size > 0 && !b.docId;
          if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map((child) => (
          <TreeItem
            key={child.name}
            node={child}
            depth={depth + 1}
            activeDocId={activeDocId}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

export function Sidebar({ activeDocId, onSelect }: SidebarProps) {
  const { docs, loading } = useDocs();
  const tree = buildTree(docs);

  return (
    <div
      style={{
        width: "220px",
        borderRight: "1px solid #e0e0e0",
        backgroundColor: "#fafafa",
        overflowY: "auto",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          padding: "16px 12px 8px",
          fontSize: "11px",
          fontWeight: 600,
          color: "#888",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}
      >
        Pages
      </div>
      {loading ? (
        <div style={{ padding: "8px 12px", color: "#999", fontSize: "13px" }}>
          Loading...
        </div>
      ) : (
        [...tree.children.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((node) => (
            <TreeItem
              key={node.name}
              node={node}
              depth={0}
              activeDocId={activeDocId}
              onSelect={onSelect}
            />
          ))
      )}
    </div>
  );
}
