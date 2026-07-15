import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  // Rendered in place of the children once a descendant throws. Receives a
  // `reset` that clears the caught error so the subtree can try mounting again.
  fallback: (reset: () => void) => ReactNode;
  // Notified on the catch so a parent can react (e.g. flip the Social Graph to
  // the list view when the WebGL graph blows up) — runs in the commit phase, so a
  // setState here is safe.
  onError?: (error: unknown) => void;
  // When any entry changes identity the boundary clears its error and remounts
  // the children — used to retry after the input that crashed has changed.
  resetKeys?: readonly unknown[];
}

interface ErrorBoundaryState {
  error: unknown;
}

// Without a boundary, an uncaught render/effect throw unmounts the whole React
// tree and leaves the near-black body background — which reads as "the screen
// went black and I had to reopen the app". This contains the blast radius to
// whatever subtree it wraps and hands back a recoverable fallback instead.
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error == null) return;
    const { resetKeys } = this.props;
    const prevKeys = prev.resetKeys;
    if (resetKeys && prevKeys && (resetKeys.length !== prevKeys.length || resetKeys.some((k, i) => k !== prevKeys[i]))) {
      this.reset();
    }
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error != null) return this.props.fallback(this.reset);
    return this.props.children;
  }
}
