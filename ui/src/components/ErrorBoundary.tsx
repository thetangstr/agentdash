import React from "react";
import { ApiError } from "@/api/client";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error, errorInfo: null };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Uncaught React error:", error, errorInfo);
    this.setState({ errorInfo });
    // TODO: pipe to a logging endpoint when one exists
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const error = this.state.error;
      // PR #220: ApiError(status=0) is the "Unable to reach the server" path
      // emitted by api/client.ts when fetch itself throws (network unreachable,
      // CORS, server down). Render a softer spinner state — the server is
      // probably coming back up, not the code being broken.
      const isServerUnreachable = error instanceof ApiError && error.status === 0;

      if (isServerUnreachable) {
        return (
          <div
            role="alert"
            className="flex flex-col items-center justify-center min-h-screen p-8"
          >
            <div className="max-w-xl w-full text-center">
              <div className="mb-6 flex justify-center">
                <div className="relative size-12">
                  <div className="absolute inset-0 rounded-full border-4 border-muted" />
                  <div className="absolute inset-0 rounded-full border-4 border-primary border-t-transparent animate-spin" />
                </div>
              </div>
              <h1 className="text-2xl font-semibold mb-3">Unable to reach the server</h1>
              <p className="text-muted-foreground mb-6">
                {error.message || "Check your connection and try again."}
              </p>
              <div className="flex gap-2 justify-center">
                <button
                  onClick={this.handleReload}
                  className="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  Reload
                </button>
                <button
                  onClick={this.handleReset}
                  className="px-4 py-2 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors"
                >
                  Try again
                </button>
              </div>
            </div>
          </div>
        );
      }

      return (
        <div
          role="alert"
          className="flex flex-col items-center justify-center min-h-screen p-8"
        >
          <div className="max-w-xl w-full text-center">
            <h1 className="text-2xl font-semibold mb-3">Something went wrong</h1>
            <p className="text-muted-foreground mb-6">
              The app hit an unexpected error. You can try reloading or going back to the last known good state.
            </p>
            <div className="flex gap-2 justify-center">
              <button
                onClick={this.handleReload}
                className="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Reload
              </button>
              <button
                onClick={this.handleReset}
                className="px-4 py-2 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors"
              >
                Try again
              </button>
            </div>
            {error && (
              <details className="mt-8 text-left">
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  Error details
                </summary>
                <pre className="mt-2 p-4 bg-muted rounded-md overflow-auto text-xs text-left">
                  {error.message}
                  {"\n"}
                  {error.stack}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
