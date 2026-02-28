// AppBlock — custom BlockNote block that hosts a live React component from an app.
//
// In the editor, this appears as an interactive block.
// The component is dynamically resolved from the component registry.
// If the component can't be found, a placeholder is shown.

import { createReactBlockSpec } from "@blocknote/react";
import { useState, useEffect, type ComponentType } from "react";
import { resolveComponent, type ResolvedComponent } from "../../renderer/component-registry";

// Error boundary for app components — crash isolation
function ErrorFallback({ componentName, error }: { componentName: string; error: string }) {
  return (
    <div
      style={{
        padding: "12px 16px",
        border: "1px solid #f5c6cb",
        borderRadius: "6px",
        backgroundColor: "#fff5f5",
        color: "#721c24",
        fontSize: "13px",
      }}
    >
      <strong>{componentName}</strong> crashed: {error}
    </div>
  );
}

function MissingComponent({ componentName }: { componentName: string }) {
  return (
    <div
      style={{
        padding: "12px 16px",
        border: "1px dashed #ccc",
        borderRadius: "6px",
        backgroundColor: "#f9f9f9",
        color: "#666",
        fontSize: "13px",
      }}
    >
      Missing component: <code>{componentName}</code>
    </div>
  );
}

function LoadingComponent() {
  return (
    <div
      style={{
        padding: "12px 16px",
        border: "1px solid #e0e0e0",
        borderRadius: "6px",
        backgroundColor: "#fafafa",
        color: "#999",
        fontSize: "13px",
      }}
    >
      Loading...
    </div>
  );
}

// The inner renderer that dynamically resolves and renders the app component.
function AppComponentRenderer({
  componentName,
  componentProps,
}: {
  componentName: string;
  componentProps: string;
}) {
  const [resolved, setResolved] = useState<ResolvedComponent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    resolveComponent(componentName)
      .then((result) => {
        if (cancelled) return;
        setResolved(result);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [componentName]);

  if (loading) return <LoadingComponent />;
  if (error) return <ErrorFallback componentName={componentName} error={error} />;
  if (!resolved) return <MissingComponent componentName={componentName} />;

  // Parse props
  let props: Record<string, unknown> = {};
  try {
    props = componentProps ? JSON.parse(componentProps) : {};
  } catch {
    // Invalid props — render with empty props
  }

  // Inject system bridge into props
  const { Component, system } = resolved;

  // Wrap in try-catch for render errors
  try {
    return <Component {...props} system={system} />;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return <ErrorFallback componentName={componentName} error={msg} />;
  }
}

// BlockNote custom block spec
export const AppBlock = createReactBlockSpec(
  {
    type: "appComponent",
    propSchema: {
      componentName: { default: "" },
      componentProps: { default: "{}" },
    },
    content: "none",
  },
  {
    render: ({ block }) => {
      const { componentName, componentProps } = block.props;

      return (
        <div
          style={{ margin: "4px 0" }}
          // Prevent BlockNote from capturing clicks inside the component
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <AppComponentRenderer
            componentName={componentName}
            componentProps={componentProps}
          />
        </div>
      );
    },
  },
);
