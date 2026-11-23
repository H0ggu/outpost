/**
 * One save at a time per board tab (ctrl.ts). Saving twice in a row (Ctrl+S pressed twice, the Save
 * button then Ctrl+S) must not send two PUTs with the same `baseUpdatedAt`: the server would answer
 * the second with 409 and the Studio would warn about a change "made elsewhere" that was its own.
 *
 * A save asked for while another one runs for the same tab waits for it, then runs only when
 * `shouldRun(previousResult)` says so (e.g. the board changed during the first save; it then goes out
 * with the base the first one returned), otherwise it answers with the first one's result.
 */
export class SaveQueue<K = string> {
  private readonly running = new Map<K, Promise<boolean>>();
  private readonly onChange: () => void;

  /** `onChange` runs when a key starts or stops being busy (to redraw a Save button). */
  constructor(onChange: () => void = () => undefined) {
    this.onChange = onChange;
  }

  busy(key: K): boolean {
    return this.running.has(key);
  }

  run(key: K, task: () => Promise<boolean>, shouldRun: (previous: boolean) => boolean = () => true): Promise<boolean> {
    const previous = this.running.get(key);
    const job = previous
      ? previous.then(ok => (shouldRun(ok) ? task() : ok))
      : Promise.resolve().then(task);
    const tracked: Promise<boolean> = job
      .catch(() => false)
      .finally(() => {
        if (this.running.get(key) !== tracked) return;
        this.running.delete(key);
        this.onChange();
      });
    this.running.set(key, tracked);
    if (!previous) this.onChange();
    return tracked;
  }
}
