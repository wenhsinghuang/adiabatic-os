// SourceEditor — Monaco Editor wrapper for app/source files.

import { useRef, useCallback } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import styles from "./SourceEditor.module.css";

interface SourceEditorProps {
  content: string;
  onSave: (content: string) => void;
  language?: string;
}

export function SourceEditor({ content, onSave, language = "plaintext" }: SourceEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMount: OnMount = useCallback(
    (editor) => {
      editorRef.current = editor;

      // Cmd+S / Ctrl+S to save immediately
      editor.addCommand(
        // eslint-disable-next-line no-bitwise
        2048 | 49, // KeyMod.CtrlCmd | KeyCode.KeyS
        () => {
          const value = editor.getValue();
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
          onSave(value);
        },
      );
    },
    [onSave],
  );

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        if (value !== undefined) onSave(value);
      }, 500);
    },
    [onSave],
  );

  return (
    <div className={styles.editor}>
      <Editor
        defaultValue={content}
        language={language}
        theme="vs-dark"
        onMount={handleMount}
        onChange={handleChange}
        options={{
          fontSize: 13,
          fontFamily: "var(--font-mono)",
          lineNumbers: "on",
          minimap: { enabled: false },
          wordWrap: "on",
          padding: { top: 12 },
          scrollBeyondLastLine: false,
          renderLineHighlight: "gutter",
          tabSize: 2,
          automaticLayout: true,
        }}
      />
    </div>
  );
}
