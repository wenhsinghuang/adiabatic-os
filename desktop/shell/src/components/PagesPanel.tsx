// PagesPanel — enhanced file tree with CRUD operations.
// Supports new page/folder, right-click delete/rename, folder collapse/expand.

import { useState, useCallback } from "react";
import { useDocs, type DocEntry } from "../hooks/useDocs";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { InlineInput } from "./InlineInput";
import * as api from "../lib/api";
import styles from "./PagesPanel.module.css";

interface PagesPanelProps {
  activeDocId: string | null;
  onSelect: (docId: string) => void;
  onDeleteDoc: (id: string) => void;
  onRenameDoc: (oldId: string, newId: string) => void;
}

interface TreeNode {
  name: string;
  docId?: string;
  fullPath: string;
  children: Map<string, TreeNode>;
}

function buildTree(docs: DocEntry[]): TreeNode {
  const root: TreeNode = { name: "", fullPath: "", children: new Map() };

  for (const doc of docs) {
    const parts = doc.id.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!current.children.has(part)) {
        const fullPath = parts.slice(0, i + 1).join("/");
        current.children.set(part, { name: part, fullPath, children: new Map() });
      }
      current = current.children.get(part)!;
      if (i === parts.length - 1) {
        current.docId = doc.id;
      }
    }
  }

  return root;
}

function sortedChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) => {
    const aIsFolder = a.children.size > 0 && !a.docId;
    const bIsFolder = b.children.size > 0 && !b.docId;
    if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function TreeItem({
  node,
  depth,
  activeDocId,
  collapsedFolders,
  onSelect,
  onToggleFolder,
  onContextMenu,
}: {
  node: TreeNode;
  depth: number;
  activeDocId: string | null;
  collapsedFolders: Set<string>;
  onSelect: (docId: string) => void;
  onToggleFolder: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
}) {
  const isFolder = node.children.size > 0 && !node.docId;
  const isActive = node.docId === activeDocId;
  const isCollapsed = collapsedFolders.has(node.fullPath);

  return (
    <>
      <div
        className={`${styles.item} ${isActive ? styles.active : ""}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={() => {
          if (isFolder) onToggleFolder(node.fullPath);
          else if (node.docId) onSelect(node.docId);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e, node);
        }}
      >
        <span className={`${styles.icon} ${isFolder ? (isCollapsed ? styles.collapsed : styles.expanded) : ""}`}>
          {isFolder ? "▸" : ""}
        </span>
        <span className={styles.name}>{node.name}</span>
      </div>
      {isFolder &&
        !isCollapsed &&
        sortedChildren(node).map((child) => (
          <TreeItem
            key={child.name}
            node={child}
            depth={depth + 1}
            activeDocId={activeDocId}
            collapsedFolders={collapsedFolders}
            onSelect={onSelect}
            onToggleFolder={onToggleFolder}
            onContextMenu={onContextMenu}
          />
        ))}
    </>
  );
}

export function PagesPanel({ activeDocId, onSelect, onDeleteDoc, onRenameDoc }: PagesPanelProps) {
  const { docs, loading, refresh } = useDocs();
  const tree = buildTree(docs);

  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null);
  const [creating, setCreating] = useState<"page" | "folder" | null>(null);
  const [renaming, setRenaming] = useState<TreeNode | null>(null);

  const toggleFolder = useCallback((path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: TreeNode) => {
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  const handleCreatePage = useCallback(
    async (name: string) => {
      setCreating(null);
      const id = name.replace(/\s+/g, "-").toLowerCase();
      await api.saveDoc(id, `# ${name}\n`);
      await refresh();
      onSelect(id);
    },
    [refresh, onSelect],
  );

  const handleCreateFolder = useCallback(
    async (name: string) => {
      setCreating(null);
      const folder = name.replace(/\s+/g, "-").toLowerCase();
      const id = `${folder}/untitled`;
      await api.saveDoc(id, `# Untitled\n`);
      await refresh();
      onSelect(id);
    },
    [refresh, onSelect],
  );

  const handleDelete = useCallback(
    async (node: TreeNode) => {
      if (!node.docId) return;
      await api.deleteDoc(node.docId);
      onDeleteDoc(node.docId);
      await refresh();
    },
    [refresh, onDeleteDoc],
  );

  const handleRenameSubmit = useCallback(
    async (newName: string) => {
      if (!renaming?.docId) {
        setRenaming(null);
        return;
      }
      const oldId = renaming.docId;
      const parts = oldId.split("/");
      parts[parts.length - 1] = newName.replace(/\s+/g, "-").toLowerCase();
      const newId = parts.join("/");

      if (newId === oldId) {
        setRenaming(null);
        return;
      }

      // Copy content to new doc, delete old
      const doc = await api.getDoc(oldId);
      await api.saveDoc(newId, doc.content, doc.metadata ?? undefined);
      await api.deleteDoc(oldId);
      onRenameDoc(oldId, newId);
      await refresh();
      setRenaming(null);
    },
    [renaming, refresh, onRenameDoc],
  );

  const contextMenuItems: MenuItem[] = contextMenu?.node
    ? [
        ...(contextMenu.node.docId
          ? [
              {
                label: "Rename",
                action: () => {
                  setRenaming(contextMenu.node);
                },
              },
              {
                label: "Delete",
                danger: true,
                action: () => handleDelete(contextMenu.node),
              },
            ]
          : []),
      ]
    : [];

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>Pages</span>
        <div className={styles.actions}>
          <button className={styles.actionBtn} title="New Page" onClick={() => setCreating("page")}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9.5 1.1l3.4 3.5.1.4v2h-1V6H8.5L8 5.5V2H3.5l-.5.5v11l.5.5H7v1H3.5l-1.5-1.5v-11l1.5-1.5h5.7l.3.1zM9 2v3h2.9L9 2zm4 12h-1v-2H10v-1h2V9h1v2h2v1h-2v2z" />
            </svg>
          </button>
          <button className={styles.actionBtn} title="New Folder" onClick={() => setCreating("folder")}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M14 4H9.618l-1-2H2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1zm0 9H2V3h6.382l1 2H14v8z" />
            </svg>
          </button>
        </div>
      </div>
      <div className={styles.tree}>
        {creating && (
          <div className={styles.inlineCreate}>
            <InlineInput
              placeholder={creating === "page" ? "page name" : "folder name"}
              onSubmit={creating === "page" ? handleCreatePage : handleCreateFolder}
              onCancel={() => setCreating(null)}
            />
          </div>
        )}
        {loading ? (
          <div className={styles.loading}>Loading...</div>
        ) : (
          sortedChildren(tree).map((node) =>
            renaming && renaming.fullPath === node.fullPath ? (
              <div key={node.name} className={styles.inlineRename} style={{ paddingLeft: "12px" }}>
                <InlineInput
                  defaultValue={node.name}
                  onSubmit={handleRenameSubmit}
                  onCancel={() => setRenaming(null)}
                />
              </div>
            ) : (
              <TreeItem
                key={node.name}
                node={node}
                depth={0}
                activeDocId={activeDocId}
                collapsedFolders={collapsedFolders}
                onSelect={onSelect}
                onToggleFolder={toggleFolder}
                onContextMenu={handleContextMenu}
              />
            ),
          )
        )}
      </div>
      {contextMenu && contextMenuItems.length > 0 && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
