import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CreateLink,
  InsertCodeBlock,
  InsertThematicBreak,
  ListsToggle,
  MDXEditor,
  type MDXEditorMethods,
  Separator,
  UndoRedo,
  type CodeBlockEditorProps,
  codeBlockPlugin,
  headingsPlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  useCodeBlockEditorContext,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { inertUnsupportedMdx } from "./markdown-normalize";
import styles from "./MarkdownPageEditor.module.css";

interface MarkdownPageEditorProps {
  content: string;
  onSave: (content: string) => void;
}

const SAVE_DELAY_MS = 500;

function PlainCodeBlockEditor({ code, language, focusEmitter }: CodeBlockEditorProps) {
  const { setCode, setLanguage } = useCodeBlockEditorContext();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    focusEmitter.subscribe(() => textareaRef.current?.focus());
  }, [focusEmitter]);

  return (
    <div className={styles.codeBlockEditor}>
      <select
        className={styles.codeLanguage}
        value={language || ""}
        onChange={(event) => setLanguage(event.target.value)}
        aria-label="Code block language"
      >
        <option value="">Plain text</option>
        <option value="md">Markdown</option>
        <option value="mdx">MDX text</option>
        <option value="js">JavaScript</option>
        <option value="ts">TypeScript</option>
        <option value="tsx">TSX</option>
        <option value="sql">SQL</option>
        <option value="json">JSON</option>
      </select>
      <textarea
        ref={textareaRef}
        className={styles.codeTextarea}
        value={code}
        onChange={(event) => setCode(event.target.value)}
        spellCheck={false}
      />
    </div>
  );
}

export function MarkdownPageEditor({ content, onSave }: MarkdownPageEditorProps) {
  const editorMarkdown = useMemo(() => inertUnsupportedMdx(content), [content]);
  const editorRef = useRef<MDXEditorMethods | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentMarkdownRef = useRef(editorMarkdown);
  const lastSavedMarkdownRef = useRef(editorMarkdown);

  const plugins = useMemo(
    () => [
      headingsPlugin({ allowedHeadingLevels: [1, 2, 3, 4] }),
      listsPlugin(),
      quotePlugin(),
      thematicBreakPlugin(),
      codeBlockPlugin({
        defaultCodeBlockLanguage: "",
        codeBlockEditorDescriptors: [
          {
            priority: 0,
            match: () => true,
            Editor: PlainCodeBlockEditor,
          },
        ],
      }),
      linkPlugin(),
      linkDialogPlugin(),
      markdownShortcutPlugin(),
      toolbarPlugin({
        toolbarContents: () => (
          <>
            <UndoRedo />
            <Separator />
            <BlockTypeSelect />
            <Separator />
            <BoldItalicUnderlineToggles />
            <ListsToggle options={["bullet", "number", "check"]} />
            <Separator />
            <CreateLink />
            <InsertCodeBlock />
            <InsertThematicBreak />
          </>
        ),
      }),
    ],
    [],
  );

  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const markdown = editorRef.current?.getMarkdown() ?? currentMarkdownRef.current;
    currentMarkdownRef.current = markdown;
    if (markdown !== lastSavedMarkdownRef.current) {
      lastSavedMarkdownRef.current = markdown;
      onSave(markdown);
    }
  }, [onSave]);

  const scheduleSave = useCallback(
    (markdown: string) => {
      currentMarkdownRef.current = markdown;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(flushSave, SAVE_DELAY_MS);
    },
    [flushSave],
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (editorMarkdown === currentMarkdownRef.current) return;
    currentMarkdownRef.current = editorMarkdown;
    lastSavedMarkdownRef.current = editorMarkdown;
    editorRef.current?.setMarkdown(editorMarkdown);
  }, [editorMarkdown]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        flushSave();
      }
    },
    [flushSave],
  );

  return (
    <div className={styles.pageEditor} onKeyDownCapture={handleKeyDown}>
      <MDXEditor
        ref={editorRef}
        markdown={editorMarkdown}
        onChange={(markdown, initialNormalize) => {
          if (initialNormalize) return;
          scheduleSave(markdown);
        }}
        onBlur={flushSave}
        onError={({ error }) => {
          console.warn("[MarkdownPageEditor] Unsupported markdown was kept inert:", error);
        }}
        suppressHtmlProcessing
        className={styles.mdxRoot}
        contentEditableClassName={styles.contentEditable}
        placeholder="Start writing..."
        plugins={plugins}
        toMarkdownOptions={{ bullet: "-", emphasis: "_" }}
      />
    </div>
  );
}
