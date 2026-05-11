// AppFileEditor — editor for app source files (manifest.json, index.tsx, etc).

import { useState, useEffect, useCallback, useRef } from "react";
import { SourceEditor } from "./SourceEditor";
import * as api from "../lib/api";
import { getContainer, reloadApp } from "../sandbox/webcontainer";
import styles from "./ContentArea.module.css";

interface AppFileEditorProps {
  appId: string;
  filename: string;
}

const LANG_MAP: Record<string, string> = {
  ".tsx": "typescript",
  ".ts": "typescript",
  ".jsx": "javascript",
  ".js": "javascript",
  ".json": "json",
  ".css": "css",
  ".md": "markdown",
  ".mdx": "mdx",
};

function getLang(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf("."));
  return LANG_MAP[ext] ?? "plaintext";
}

export function AppFileEditor({ appId, filename }: AppFileEditorProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const currentKey = useRef(`${appId}/${filename}`);

  useEffect(() => {
    const key = `${appId}/${filename}`;
    currentKey.current = key;
    setLoading(true);
    setError(null);

    api
      .getAppSource(appId)
      .then((files) => {
        if (currentKey.current !== key) return;
        if (filename in files) {
          setContent(files[filename]);
        } else {
          setError("File not found");
        }
        setLoading(false);
      })
      .catch((err) => {
        if (currentKey.current !== key) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [appId, filename]);

  const handleSave = useCallback(
    (value: string) => {
      setContent(value);
      api
        .saveAppFile(appId, filename, value)
        .then(async () => {
          // Rebuild only if the app runtime sandbox is already active.
          if (getContainer()) {
            await reloadApp(appId);
            console.log(`[AppFileEditor] Rebuilt app "${appId}"`);
          }
        })
        .catch((err) => {
          console.error("[AppFileEditor] Save/rebuild failed:", err);
        });
    },
    [appId, filename],
  );

  if (loading) return <div className={styles.loading}>Loading...</div>;
  if (error) return <div className={styles.error}>Error: {error}</div>;
  if (content === null) return <div className={styles.empty}>File not found</div>;

  return <SourceEditor content={content} onSave={handleSave} language={getLang(filename)} />;
}
