// PageView — container for the current page.
// Handles view/source mode switching and wiring to save.

import { useCallback, useState } from "react";
import { Editor } from "./Editor";
import { SourceEditor } from "./SourceEditor";
import { useDoc } from "../hooks/useDoc";

export type EditorMode = "view" | "source";

interface PageViewProps {
  docId: string;
  mode: EditorMode;
}

export function PageView({ docId, mode }: PageViewProps) {
  const { doc, loading, error, save } = useDoc(docId);
  const [lastSavedContent, setLastSavedContent] = useState<string | null>(null);

  const handleSave = useCallback(
    (mdx: string) => {
      setLastSavedContent(mdx);
      save(mdx);
    },
    [save],
  );

  if (loading) {
    return (
      <div style={{ padding: "48px", color: "#999" }}>Loading...</div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: "48px", color: "#c0392b" }}>
        Error loading page: {error}
      </div>
    );
  }

  if (!doc) {
    return (
      <div style={{ padding: "48px", color: "#999" }}>Page not found.</div>
    );
  }

  const content = lastSavedContent ?? doc.content;

  if (mode === "source") {
    return (
      <SourceEditor
        docId={docId}
        initialContent={content}
        onSave={handleSave}
      />
    );
  }

  return (
    <Editor
      docId={docId}
      initialContent={content}
      onSave={handleSave}
    />
  );
}
