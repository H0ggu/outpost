import { useEffect, type ReactNode } from 'react';

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
