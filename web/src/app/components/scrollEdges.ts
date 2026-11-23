/**
 * Scroll affordance for horizontal scrollers (phone sub-navs, wide charts): which edges have more
 * content beyond them, so the scroller can fade out there (`.scroll-fade--left/--right` in
 * components.css) instead of cutting a label off with no hint that it scrolls.
 *
 *   const ref = useRef<HTMLDivElement>(null);
 *   const edges = useScrollEdges(ref);
 *   <div ref={ref} className={scrollFadeClass('my-scroller', edges)}>…</div>
 */
import { useCallback, useEffect, useState, type RefObject } from 'react';

/** Edges of a scroller with hidden content beyond them. */
export interface ScrollEdges {
  left: boolean;
  right: boolean;
}

/** The hidden-content edges of `el` (1px of slack for fractional widths). */
export function scrollEdgesOf(el: Pick<HTMLElement, 'scrollLeft' | 'scrollWidth' | 'clientWidth'>): ScrollEdges {
  const max = el.scrollWidth - el.clientWidth;
  return { left: max > 1 && el.scrollLeft > 1, right: max > 1 && el.scrollLeft < max - 1 };
}

/** Tracks `scrollEdgesOf(ref.current)` across scrolling and resizes of the scroller or its content. */
export function useScrollEdges(ref: RefObject<HTMLElement | null>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ left: false, right: false });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = scrollEdgesOf(el);
    setEdges(prev => (prev.left === next.left && prev.right === next.right ? prev : next));
  }, [ref]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener('scroll', update, { passive: true });
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update);
      ro.observe(el);
      for (const child of el.children) ro.observe(child);
    }
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [ref, update]);
  return edges;
}

/** `base` plus the fade modifiers for `edges`. */
export const scrollFadeClass = (base: string, edges: ScrollEdges): string =>
  [base, edges.left && 'scroll-fade--left', edges.right && 'scroll-fade--right'].filter(Boolean).join(' ');
