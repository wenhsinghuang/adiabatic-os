// InlineInput — auto-focus text input for inline creation/rename.
// Submit on Enter, cancel on Escape or blur.

import { useRef, useEffect } from "react";
import styles from "./InlineInput.module.css";

interface InlineInputProps {
  defaultValue?: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function InlineInput({ defaultValue = "", placeholder, onSubmit, onCancel }: InlineInputProps) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      className={styles.input}
      defaultValue={defaultValue}
      placeholder={placeholder}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const val = (e.target as HTMLInputElement).value.trim();
          if (val) onSubmit(val);
          else onCancel();
        }
        if (e.key === "Escape") onCancel();
      }}
      onBlur={(e) => {
        const val = e.target.value.trim();
        if (val) onSubmit(val);
        else onCancel();
      }}
    />
  );
}
