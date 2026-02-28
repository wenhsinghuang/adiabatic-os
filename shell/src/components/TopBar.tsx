// TopBar — navigation + view/source mode switch.

import type { EditorMode } from "../editor/PageView";

interface TopBarProps {
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  docId: string | null;
}

export function TopBar({ mode, onModeChange, docId }: TopBarProps) {
  return (
    <div
      style={{
        height: "44px",
        borderBottom: "1px solid #e0e0e0",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 16px",
        backgroundColor: "#fff",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ fontWeight: 600, fontSize: "14px", color: "#333" }}>
          Adiabatic
        </span>
        {docId && (
          <span style={{ fontSize: "13px", color: "#888" }}>
            / {docId}
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: "2px" }}>
        <ModeButton
          label="View"
          active={mode === "view"}
          onClick={() => onModeChange("view")}
        />
        <ModeButton
          label="Source"
          active={mode === "source"}
          onClick={() => onModeChange("source")}
        />
      </div>
    </div>
  );
}

function ModeButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "4px 12px",
        fontSize: "12px",
        fontWeight: active ? 600 : 400,
        border: "1px solid",
        borderColor: active ? "#1a73e8" : "#ddd",
        borderRadius: "4px",
        backgroundColor: active ? "#e8f0fe" : "#fff",
        color: active ? "#1a73e8" : "#666",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
