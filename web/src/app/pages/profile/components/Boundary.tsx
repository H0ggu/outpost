/**
 * A local error boundary: a failure inside one widget (a lazily loaded chunk that can't be
 * fetched, a viewer that throws on odd PGN) shows an inline error with a retry instead of
 * replacing the whole profile page with the route's error screen.
 */
import { Component, type ReactNode } from 'react';
import { ErrorBox } from '../../../components/index.ts';

interface Props {
  title: string;
  children: ReactNode;
}

interface State {
  error: unknown;
}

export class Boundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error ?? new Error('Unknown error') };
  }

  override render() {
    if (this.state.error) return <ErrorBox error={this.state.error} title={this.props.title} onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}
