import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The last line of defence against a blank window.
 *
 * A single failed import or a render error takes React down with it, and what
 * the user gets is a white rectangle that says nothing - the worst possible
 * failure for a desktop app, because there is nowhere to look. This catches it
 * and shows what broke, so the person in front of the screen can act.
 *
 * Deliberately dependency-free: no i18n, no stores, no icons. Whatever failed
 * might be exactly those.
 */
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Aime failed to render:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div style={{ padding: "2rem", fontFamily: "Inter, system-ui, sans-serif", lineHeight: 1.6 }}>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>Aime could not start</h1>
        <p style={{ margin: "0 0 1rem", opacity: 0.75 }}>
          Something failed while the window was loading. If you are running from source, restarting{" "}
          <code>npm run tauri dev</code> fixes this whenever dependencies changed underneath it.
        </p>
        <pre
          style={{
            whiteSpace: "pre-wrap",
            padding: "0.75rem",
            borderRadius: "0.5rem",
            background: "rgba(127,127,127,0.12)",
            fontSize: "0.8rem",
          }}
        >
          {error.message}
        </pre>
        <button
          onClick={() => {
            window.location.reload();
          }}
          style={{
            marginTop: "1rem",
            padding: "0.5rem 1rem",
            borderRadius: "0.5rem",
            border: "1px solid rgba(127,127,127,0.4)",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
