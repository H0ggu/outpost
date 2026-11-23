import { useEffect, type ReactNode } from 'react';
import { licon } from '../../lichess/licon.ts';
import { Box } from './Box.tsx';
import { EmptyState } from './Feedback.tsx';

/** Sets `document.title` to `<title> · Outpost`. */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · Outpost` : 'Outpost';
  }, [title]);
}

/** Page wrapper: sets the document title and lays out its children in a column. */
export function Page({ title, narrow = false, children }: { title: string; narrow?: boolean; children?: ReactNode }) {
  useDocumentTitle(title);
  return <div className={['page', narrow && 'page--narrow'].filter(Boolean).join(' ')}>{children}</div>;
}

/**
 * Placeholder for pages not built yet. Renders the page title so routing can be tested;
 * replace the whole component when implementing the page.
 */
export function StubPage({ title, plan, children }: { title: string; plan: string; children?: ReactNode }) {
  return (
    <Page title={title}>
      <Box title={title}>
        <EmptyState icon={licon.Tools} title="Not built yet">
          <p className="stub-notice">{plan}</p>
          {children}
        </EmptyState>
      </Box>
    </Page>
  );
}
