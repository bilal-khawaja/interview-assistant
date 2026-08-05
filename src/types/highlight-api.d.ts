// CSS Custom Highlight API — supported by Chromium/Electron but not yet in
// TypeScript's bundled DOM lib. Minimal surface used by find-in-page.
declare class Highlight {
  constructor(...ranges: Range[]);
  add(range: Range): void;
  clear(): void;
}

interface CSSHighlightRegistry {
  set(name: string, highlight: Highlight): void;
  delete(name: string): void;
}

interface CSS {
  highlights: CSSHighlightRegistry;
}
