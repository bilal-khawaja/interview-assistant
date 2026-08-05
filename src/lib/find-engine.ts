import { useCallback, useRef, useState, type RefObject } from 'react';

export type FindResult = { activeMatchOrdinal: number; matches: number };

export type FindEngine = {
  search: (query: string) => void;
  next: () => void;
  prev: () => void;
  clear: () => void;
  result: FindResult | null;
};

const MATCH_HIGHLIGHT = 'find-match';
const ACTIVE_HIGHLIGHT = 'find-match-active';

function collectRanges(root: HTMLElement, query: string): Range[] {
  const ranges: Range[] = [];
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? '';
    const haystack = text.toLowerCase();
    let from = 0;
    let idx: number;
    while ((idx = haystack.indexOf(needle, from)) !== -1) {
      const range = new Range();
      range.setStart(node, idx);
      range.setEnd(node, idx + needle.length);
      ranges.push(range);
      from = idx + needle.length;
    }
  }
  return ranges;
}

/** Find-in-page over a plain DOM subtree using the CSS Custom Highlight API — no DOM mutation, safe alongside React re-renders. */
export function useDomFindEngine(containerRef: RefObject<HTMLElement | null>): FindEngine {
  const rangesRef = useRef<Range[]>([]);
  const activeIndexRef = useRef(0);
  const [result, setResult] = useState<FindResult | null>(null);

  const applyActive = useCallback(() => {
    const ranges = rangesRef.current;
    if (ranges.length === 0) {
      CSS.highlights.delete(ACTIVE_HIGHLIGHT);
      setResult({ activeMatchOrdinal: 0, matches: 0 });
      return;
    }
    const active = ranges[activeIndexRef.current];
    CSS.highlights.set(ACTIVE_HIGHLIGHT, new Highlight(active));
    const el = active.startContainer.parentElement;
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setResult({ activeMatchOrdinal: activeIndexRef.current + 1, matches: ranges.length });
  }, []);

  const clear = useCallback(() => {
    CSS.highlights.delete(MATCH_HIGHLIGHT);
    CSS.highlights.delete(ACTIVE_HIGHLIGHT);
    rangesRef.current = [];
    activeIndexRef.current = 0;
    setResult(null);
  }, []);

  const search = useCallback(
    (query: string) => {
      const container = containerRef.current;
      if (!container || !query) {
        clear();
        return;
      }
      const ranges = collectRanges(container, query);
      rangesRef.current = ranges;
      activeIndexRef.current = 0;
      CSS.highlights.set(MATCH_HIGHLIGHT, new Highlight(...ranges));
      applyActive();
    },
    [containerRef, clear, applyActive],
  );

  const next = useCallback(() => {
    const count = rangesRef.current.length;
    if (count === 0) return;
    activeIndexRef.current = (activeIndexRef.current + 1) % count;
    applyActive();
  }, [applyActive]);

  const prev = useCallback(() => {
    const count = rangesRef.current.length;
    if (count === 0) return;
    activeIndexRef.current = (activeIndexRef.current - 1 + count) % count;
    applyActive();
  }, [applyActive]);

  return { search, next, prev, clear, result };
}
