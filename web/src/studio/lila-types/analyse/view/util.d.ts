/** web/vendor/lila/analyse/src/view/util.ts (subset). */
import type { VNode } from 'snabbdom';

/** lila's snabbdom patch (class, attributes, props and event listener modules). */
export const patch: (oldVnode: VNode | Element | DocumentFragment, vnode: VNode) => VNode;
