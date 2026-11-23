/**
 * A local error boundary: a failure inside one widget (a lazily loaded chunk that can't be
 * fetched, a viewer that throws on odd PGN) shows an inline error with a retry instead of
 * replacing the whole profile page with the route's error screen.
 *
 * React.lazy remembers a failed import, so clearing the error alone would fail again: Retry
 * calls `onReset` first, where the owner swaps in a fresh `lazy()` that imports the chunk anew.
 * When a chunk fails to load again after that (the app was redeployed and the old chunk is
 * gone, or the browser keeps the failed module), Retry reloads the page instead.
 */
import { Component, type ReactNode } from 'react';
import { ErrorBox } from '../../../components/index.ts';

interface Props {
  title: string;
  children: ReactNode;
  /** Called before the boundary clears its error (e.g. to recreate a lazy component). */
  onReset?: () => void;
}

interface State {
  error: unknown;
  /** Chunk-load failures since the last retry that rendered without one. */
  chunkFailures: number;
}

/** Whether an error is a failed dynamic import (Chromium, Firefox, Safari wording; Vite preload). */
export function isChunkLoadError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return /dynamically imported module|Importing a module script failed|Unable to preload|ChunkLoadError|Loading chunk/i.test(msg);
}

export class Boundary extends Component<Props, State> {
  override state: State = { error: null, chunkFailures: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error ?? new Error('Unknown error') };
  }

  override componentDidCatch(error: unknown): void {
    this.setState(s => ({ chunkFailures: isChunkLoadError(error) ? s.chunkFailures + 1 : 0 }));
  }

  private retry = (): void => {
    if (this.state.chunkFailures > 1) {
      window.location.reload();
      return;
    }
    this.props.onReset?.();
    this.setState({ error: null });
  };

  override render() {
    const { error, chunkFailures } = this.state;
    if (!error) return this.props.children;
    const title = chunkFailures > 1 ? `${this.props.title}: Retry reloads the page` : this.props.title;
    return <ErrorBox error={error} title={title} onRetry={this.retry} />;
  }
}
