/**
 * Loading / error / sign-in states shared by the library pages, so every list and panel looks
 * the same while it loads, when it fails, and when the visitor isn't signed in.
 */
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { ApiError } from '../../../api/client.ts';
import { useSession } from '../../../api/hooks.ts';
import { ButtonLink, EmptyState, ErrorBox, licon, Spinner } from '../../../components/index.ts';
import { paths } from '../../../paths.ts';

/** The server said "sign in first" (401). */
export const isUnauthorized = (e: unknown): boolean => e instanceof ApiError && e.status === 401;

/** The current path plus query, for `?next=` after signing in. */
export function useHere(): string {
  const loc = useLocation();
  return `${loc.pathname}${loc.search}`;
}

/** "Sign in to see …" with a sign-in button (and sign-up when the instance allows it). */
export function SignInPrompt({ what = 'this page', children }: { what?: string; children?: ReactNode }) {
  const here = useHere();
  const session = useSession();
  const canSignUp = session.data && session.data.signupMode !== 'closed';
  return (
    <EmptyState icon={licon.User} title={`Sign in to see ${what}`}>
      {children}
      <div className="lib-actions lib-actions--center">
        <ButtonLink to={paths.login(here)} icon={licon.User}>
          Sign in
        </ButtonLink>
        {canSignUp && (
          <ButtonLink to={paths.signup()} variant="secondary">
            Create an account
          </ButtonLink>
        )}
      </div>
    </EmptyState>
  );
}

/** The subset of a TanStack query result that `QueryView` reads. */
export interface QueryLike<T> {
  data: T | undefined;
  error: unknown;
  isPending: boolean;
  isError: boolean;
  refetch: () => unknown;
}

/**
 * Renders `children(data)` once a query has data; a spinner while it loads; a sign-in prompt on
 * 401; otherwise an error box with Retry. A failed background refetch keeps showing the old data.
 */
export function QueryView<T>({
  query,
  children,
  loading,
  errorTitle,
  what,
}: {
  query: QueryLike<T>;
  children: (data: T) => ReactNode;
  loading?: ReactNode;
  errorTitle?: ReactNode;
  /** Used in the sign-in prompt: "Sign in to see <what>". */
  what?: string;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isError) {
    if (isUnauthorized(query.error)) return <SignInPrompt what={what} />;
    return <ErrorBox error={query.error} title={errorTitle} onRetry={() => void query.refetch()} />;
  }
  return <>{loading ?? <Spinner center />}</>;
}
