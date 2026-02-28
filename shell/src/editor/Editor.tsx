// View Mode Editor — BlockNote with live app components.
//
// - Text blocks: click to edit, Notion-like experience
// - App components: interactive React islands inside the document
// - Auto-save: debounced 300ms after changes

import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { useCallback, useEffect, useRef } from "react";
import { schema } from "./schema";
import { mdxToBlocks, blocksToMdx } from "./serializer";
import "@blocknote/mantine/style.css";

interface EditorProps {
  docId: string;
  initialContent: string;
  onSave: (mdx: string) => void;
}

export function Editor({ docId, initialContent, onSave }: EditorProps) {
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef(initialContent);

  const editor = useCreateBlockNote({ schema });

  // Load MDX content into BlockNote blocks
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const blocks = await mdxToBlocks(editor, initialContent);
      if (cancelled) return;
      editor.replaceBlocks(editor.document, blocks);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [editor, docId]); // re-load when docId changes

  // Auto-save on changes (debounced 300ms)
  const handleChange = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    saveTimerRef.current = setTimeout(async () => {
      const mdx = await blocksToMdx(editor, editor.document);
      // Only save if content actually changed
      if (mdx !== contentRef.current) {
        contentRef.current = mdx;
        onSave(mdx);
      }
    }, 300);
  }, [editor, onSave]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  return <BlockNoteView editor={editor} onChange={handleChange} theme="light" />;
}
