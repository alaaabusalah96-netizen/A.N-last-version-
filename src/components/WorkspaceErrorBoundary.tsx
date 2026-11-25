import React from 'react';
import { ErrorBanner } from './ui/ErrorBanner.js';

interface WorkspaceErrorBoundaryProps {
  children: React.ReactNode;
  resetKey?: string;
}

interface WorkspaceErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  retryNonce: number;
}

export class WorkspaceErrorBoundary extends React.Component<
  WorkspaceErrorBoundaryProps,
  WorkspaceErrorBoundaryState
> {
  constructor(props: WorkspaceErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      retryNonce: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<WorkspaceErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('Workspace error boundary caught error:', error, errorInfo);
  }

  componentDidUpdate(prevProps: WorkspaceErrorBoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false, error: null });
    }
  }

  private handleRetry = (): void => {
    const msg = this.state.error?.message || '';
    if (/dynamically imported module|Loading chunk|ChunkLoadError|Failed to fetch/i.test(msg)) {
      window.location.reload();
      return;
    }
    this.setState((prev) => ({
      hasError: false,
      error: null,
      retryNonce: prev.retryNonce + 1,
    }));
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      const detail = this.state.error?.message ? ` (${this.state.error.message})` : '';
      return (
        <ErrorBanner
          message={`تعذر تحميل أو عرض مساحة العمل${detail}. يرجى إعادة المحاولة.`}
          onRetry={this.handleRetry}
          retryLabel="إعادة المحاولة"
        />
      );
    }

    return <React.Fragment key={this.state.retryNonce}>{this.props.children}</React.Fragment>;
  }
}
