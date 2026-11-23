import type { ReactNode } from 'react';
import { licon, type LiconValue } from '../../lichess/licon.ts';
import { ApiError } from '../api/client.ts';
import { Button } from './Button.tsx';

/** Loading indicator. `center` wraps it in a padded, centred block. */
export function Spinner({ size = 40, center = false, label = 'Loading' }: { size?: number; center?: boolean; label?: string }) {
  const s = <span className="spinner" role="status" aria-label={label} style={{ ['--spinner-size' as string]: `${size}px` }} />;
  return center ? <div className="spinner-center">{s}</div> : s;
}

/** "Nothing here yet" block with an icon, a title and optional text / actions. */
export function EmptyState({ icon = licon.InfoCircle, title, children }: { icon?: LiconValue; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <i data-icon={icon} aria-hidden />
      <p className="empty-state__title">{title}</p>
      {children}
    </div>
  );
}

/** Human-readable message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Error panel for a failed query or mutation, with an optional retry button. */
export function ErrorBox({ error, onRetry, title = 'Something went wrong' }: { error: unknown; onRetry?: () => void; title?: ReactNode }) {
  const code = error instanceof ApiError ? error.code : null;
  return (
    <div className="error-box" role="alert">
      <i data-icon={licon.CautionTriangle} aria-hidden />
      <div className="error-box__body">
        <strong>{title}</strong>
        <div>{errorMessage(error)}</div>
        {code && <div className="error-box__code">{code}</div>}
      </div>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry} icon={licon.Reload}>
          Retry
        </Button>
      )}
    </div>
  );
}
