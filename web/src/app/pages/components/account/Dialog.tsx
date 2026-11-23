/**
 * Modal dialogs on the native `<dialog>` element (focus trap, Escape and the top layer for free):
 * `Modal` for any content, `ConfirmDialog` for destructive actions (optionally asking the admin to
 * type a name before the button unlocks). Mount them only while open.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button, licon, type ButtonVariant } from '../../../components/index.ts';
import { describeError, Flash } from './forms.tsx';
import './account.css';

/** A modal dialog, shown on mount; Escape, the close button and a backdrop click call `onClose`. */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
  className,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) {
      try {
        d.showModal();
      } catch {
        d.setAttribute('open', '');
      }
    }
    return () => {
      if (d.open) d.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={['acc-dialog', wide && 'acc-dialog--wide', className].filter(Boolean).join(' ')}
      aria-labelledby={titleId}
      onCancel={e => {
        e.preventDefault();
        onCloseRef.current();
      }}
      onMouseDown={e => {
        // A click on the backdrop lands on the <dialog> itself (its content box is a child).
        if (e.target === ref.current) onCloseRef.current();
      }}
    >
      <div className="acc-dialog__box">
        <header className="acc-dialog__head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="acc-dialog__close" data-icon={licon.X} aria-label="Close" onClick={() => onCloseRef.current()} />
        </header>
        <div className="acc-dialog__body">{children}</div>
        {footer && <footer className="acc-dialog__foot">{footer}</footer>}
      </div>
    </dialog>
  );
}

/**
 * Asks before doing something. `onConfirm` may return a promise: the dialog shows progress, keeps
 * itself open with the error if it fails, and closes when it succeeds. With `typeToConfirm`, the
 * confirm button only unlocks once that exact text is typed.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  variant = 'red',
  icon = licon.Trash,
  typeToConfirm,
  onConfirm,
  onClose,
}: {
  title: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  variant?: ButtonVariant;
  icon?: (typeof licon)[keyof typeof licon];
  typeToConfirm?: string;
  onConfirm: () => unknown;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inputId = useId();
  const locked = typeToConfirm !== undefined && typed.trim() !== typeToConfirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (locked || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={busy ? () => undefined : onClose}>
      <form onSubmit={submit} className="acc-confirm">
        {children}
        {typeToConfirm !== undefined && (
          <div className="form-group acc-field">
            <label htmlFor={inputId} className="acc-label">
              Type <strong className="acc-mono">{typeToConfirm}</strong> to confirm
            </label>
            <input
              id={inputId}
              className="form-control"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              onChange={e => setTyped(e.target.value)}
            />
          </div>
        )}
        {error !== null && <Flash kind="failure">{describeError(error)}</Flash>}
        <div className="acc-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant={variant} icon={icon} disabled={locked || busy} autoFocus={typeToConfirm === undefined}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
