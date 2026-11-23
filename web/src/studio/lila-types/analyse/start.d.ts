/** web/vendor/lila/analyse/src/start.ts: mounts the analysis board on `main.analyse`. */
import type { VNode } from 'snabbdom';
import type { AnalyseApi, AnalyseOpts } from './interfaces';

type Patch = (oldVnode: VNode | Element | DocumentFragment, vnode: VNode) => VNode;

/** `makeStart(patch)(opts)`; the controller is then `site.analysis`. */
export default function makeStart(patch: Patch): (opts: AnalyseOpts) => AnalyseApi;
