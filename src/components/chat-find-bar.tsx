import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useDomFindEngine } from '@/lib/find-engine';
import { FindBarPanel } from '@/components/find-bar-panel';

/** Find-in-page for a plain chat pane (messages, markdown, web-search results) — no webview involved. */
export function ChatFindBar({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const engine = useDomFindEngine(containerRef);

    const close = useCallback(() => {
        engine.clear();
        setOpen(false);
        setQuery('');
    }, [engine]);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
                e.preventDefault();
                setOpen(true);
            } else if (e.key === 'Escape' && open) {
                close();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [open, close]);

    if (!open) return null;

    return <FindBarPanel engine={engine} query={query} setQuery={setQuery} onClose={close} inputRef={inputRef} />;
}
