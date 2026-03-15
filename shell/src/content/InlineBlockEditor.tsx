// InlineBlockEditor — Chrome-less Monaco editor for inline text block editing.
// Replaces contentEditable in the Obsidian-style editor.

import { useRef, useEffect, useCallback } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as monacoEditor } from "monaco-editor";

interface InlineBlockEditorProps {
  source: string;
  onSave: (newSource: string) => void;
  onCancel: () => void;
  onSlash?: (filter: string, position: { x: number; y: number }) => void;
  style?: React.CSSProperties;
}

export function InlineBlockEditor({
  source,
  onSave,
  onCancel,
  onSlash,
  style,
}: InlineBlockEditorProps) {
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const savedRef = useRef(false);

  // Auto-resize container to fit content
  const updateHeight = useCallback(() => {
    const editor = editorRef.current;
    const container = containerRef.current;
    if (!editor || !container) return;
    const h = editor.getContentHeight();
    container.style.height = h + "px";
    editor.layout();
  }, []);

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;

      // Auto-height
      editor.onDidContentSizeChange(updateHeight);
      updateHeight();

      // Focus
      editor.focus();

      // Place cursor at end
      const model = editor.getModel();
      if (model) {
        const lastLine = model.getLineCount();
        const lastCol = model.getLineMaxColumn(lastLine);
        editor.setPosition({ lineNumber: lastLine, column: lastCol });
      }

      // Escape → cancel
      editor.addCommand(monaco.KeyCode.Escape, () => {
        savedRef.current = true; // prevent blur from double-firing
        onCancel();
      });

      // Blur → save
      editor.onDidBlurEditorText(() => {
        if (savedRef.current) return;
        savedRef.current = true;
        const value = editor.getValue();
        onSave(value);
      });

      // Slash command detection
      if (onSlash) {
        editor.onDidChangeModelContent(() => {
          const m = editor.getModel();
          const pos = editor.getPosition();
          if (!m || !pos) return;
          const lineContent = m.getLineContent(pos.lineNumber);
          const beforeCursor = lineContent.substring(0, pos.column - 1);
          const slashIdx = beforeCursor.lastIndexOf("/");
          if (
            slashIdx === -1 ||
            (slashIdx > 0 && !/\s/.test(beforeCursor[slashIdx - 1]))
          ) {
            onSlash("", { x: 0, y: 0 });
            return;
          }
          const filter = beforeCursor.substring(slashIdx + 1);
          if (!/^\w*$/.test(filter)) {
            onSlash("", { x: 0, y: 0 });
            return;
          }
          const coords = editor.getScrolledVisiblePosition(pos);
          const editorDom = editor.getDomNode();
          if (coords && editorDom) {
            const rect = editorDom.getBoundingClientRect();
            onSlash(filter, {
              x: rect.left + coords.left,
              y: rect.top + coords.top + coords.height,
            });
          }
        });
      }
    },
    [onSave, onCancel, onSlash, updateHeight],
  );

  return (
    <div ref={containerRef} style={{ minHeight: 26, ...style }}>
      <Editor
        defaultValue={source}
        language="markdown"
        theme="vs"
        onMount={handleMount}
        options={{
          fontSize: 15,
          fontFamily: "var(--font-sans)",
          lineHeight: 26,
          lineNumbers: "off",
          glyphMargin: false,
          folding: false,
          lineDecorationsWidth: 0,
          lineNumbersMinChars: 0,
          minimap: { enabled: false },
          renderLineHighlight: "none",
          overviewRulerBorder: false,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          scrollBeyondLastLine: false,
          scrollbar: { vertical: "hidden", horizontal: "hidden" },
          padding: { top: 0, bottom: 0 },
          wordWrap: "on",
          automaticLayout: true,
          contextmenu: false,
          quickSuggestions: false,
          suggestOnTriggerCharacters: false,
          parameterHints: { enabled: false },
          tabSize: 2,
        }}
      />
    </div>
  );
}
