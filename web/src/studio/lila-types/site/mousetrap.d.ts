/** web/vendor/lila/site/src/mousetrap.ts: lila's keyboard shortcut binder. */
export default class Mousetrap implements LichessMousetrap {
  constructor(targetElement?: HTMLElement | Document);
  bind(
    keys: string | string[],
    callback: (e: KeyboardEvent) => void,
    action?: 'keypress' | 'keydown' | 'keyup',
    multiple?: boolean,
  ): this;
  unbind(key: string): void;
}
