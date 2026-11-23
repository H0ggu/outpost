/** web/vendor/lila/lib/src/pubsub.ts (subset). */
export const pubsub: {
  on(name: string, cb: (...args: any[]) => void): void;
  off(name: string, cb: (...args: any[]) => void): void;
  emit(name: string, ...args: any[]): void;
};
