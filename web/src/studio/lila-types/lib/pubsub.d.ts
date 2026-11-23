/** web/vendor/lila/lib/src/pubsub.ts (subset). */
export const pubsub: {
  on(name: string, cb: (...args: any[]) => void): void;
  off(name: string, cb: (...args: any[]) => void): void;
  emit(name: string, ...args: any[]): void;
  /** Completes a one-time event (`after(event)` resolves with `value`). */
  complete(event: 'polyfill.dialog', value: ((dialog: HTMLElement) => void) | undefined): void;
};
