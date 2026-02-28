// Source Mode Editor — plain text MDX editing.
// D1: simple textarea. Future: CodeMirror 6 with MDX syntax highlighting.

import { useState, useCallback, useRef, useEffect } from "react";

interface SourceEditorProps {
  docId: string;
  initialContent: string;
  onSave: (mdx: string) => void;
}

export function SourceEditor({ docId, initialContent, onSave }: SourceEditorProps) {
  const [content, setContent] = useState(initialContent);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset content when docId changes
  useEffect(() => {
    setContent(initialContent);
  }, [docId, initialContent]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setContent(value);

      // Debounced auto-save
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        onSave(value);
      }, 300);
    },
    [onSave],
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  return (
    <textarea
      value={content}
      onChange={handleChange}
      spellCheck={false}
      style={{
        width: "100%",
        height: "100%",
        border: "none",
        outline: "none",
        resize: "none",
        padding: "24px 48px",
        fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
        fontSize: "14px",
        lineHeight: "1.6",
        color: "#1a1a1a",
        backgroundColor: "#fff",
      }}
    />
  );
}
