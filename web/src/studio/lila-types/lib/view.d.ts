/** web/vendor/lila/lib/src/view (subset): lila's dialogs, used for Studio's own dialogs too. */
import type { VNode } from 'snabbdom';

export interface Dialog {
  readonly view: HTMLElement;
  readonly dialog: HTMLDialogElement;
  readonly returnValue?: string;
  show(): Promise<Dialog>;
  redraw(): void;
  close(returnValue?: string): void;
}

interface DialogOpts {
  class?: string;
  css?: CssLocation[];
  focus?: string;
  onShow?: (dialog: Dialog) => void;
  onClose?: (dialog: Dialog) => void;
  closeButton?: boolean;
  noScrollable?: boolean;
  show?: boolean;
  modal?: boolean;
  easyClose?: 'anyClick' | 'clickOutside';
}

export function domDialog(o: DialogOpts & { htmlText?: string }): Promise<Dialog>;
export function snabDialog(
  o: DialogOpts & { render: (redraw: () => void, dialog: Dialog) => Array<VNode | string | undefined | false> },
): Promise<Dialog>;
export function alert(msg: string): Promise<void>;
export function confirm(msg: string, ok?: string, cancel?: string): Promise<boolean>;
export function prompt(msg: string, def?: string, valid?: (text: string) => boolean): Promise<string | null>;
