// ErrorBoundary — catches render errors in child components.

import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  fallback?: ReactNode;
  children: ReactNode;
  resetKey?: unknown;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prevProps: Props) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          style={{
            padding: "16px",
            margin: "8px 0",
            background: "#fff0f0",
            border: "1px solid #ffccc7",
            borderRadius: "4px",
            color: "#a8071a",
            fontFamily: "var(--font-mono)",
            fontSize: "12px",
          }}
        >
          <strong>Component Error</strong>
          <pre style={{ marginTop: "4px", whiteSpace: "pre-wrap" }}>
            {this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
