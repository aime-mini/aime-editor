import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { watchForUncaughtErrors } from "./lib/diagnostics";
import "./index.css";

// Nothing that fails should fail silently, including before React mounts.
watchForUncaughtErrors();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* A desktop app must never fail to a blank window: whatever breaks, say so. */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
