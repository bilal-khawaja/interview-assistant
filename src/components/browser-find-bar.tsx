import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { windowHandlers } from '@/lib/tipc-client';
import type { FindEngine, FindResult } from '@/lib/find-engine';
import { FindBarPanel } from '@/components/find-bar-panel';

function useWebviewFindEngine(webviewRef: RefObject<Electron.WebviewTag | null>): FindEngine {
    const [result, setResult] = useState<FindResult | null>(null);
    const queryRef = useRef('');

    useEffect(() => {
        const webview = webviewRef.current;
        if (!webview) return;
        const onFound = (e: Electron.FoundInPageEvent) => {
            setResult({ activeMatchOrdinal: e.result.activeMatchOrdinal, matches: e.result.matches });
        };
        webview.addEventListener('found-in-page', onFound);
        return () => {
            webview.removeEventListener('found-in-page', onFound);
        };
    }, [webviewRef]);

    const search = useCallback(
        (text: string) => {
            queryRef.current = text;
            const webview = webviewRef.current;
            if (!webview) return;
            if (!text) {
                webview.stopFindInPage('clearSelection');
                setResult(null);
                return;
            }
            webview.findInPage(text, { forward: true, findNext: false });
        },
        [webviewRef],
    );

    const next = useCallback(() => {
        if (!queryRef.current) return;
        webviewRef.current?.findInPage(queryRef.current, { forward: true, findNext: true });
    }, [webviewRef]);

    const prev = useCallback(() => {
        if (!queryRef.current) return;
        webviewRef.current?.findInPage(queryRef.current, { forward: false, findNext: true });
    }, [webviewRef]);

    const clear = useCallback(() => {
        queryRef.current = '';
        webviewRef.current?.stopFindInPage('clearSelection');
        setResult(null);
    }, [webviewRef]);

    return { search, next, prev, clear, result };
}

export function BrowserFindBar({ webviewRef }: { webviewRef: RefObject<Electron.WebviewTag | null> }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const engine = useWebviewFindEngine(webviewRef);

    const close = useCallback(() => {
        engine.clear();
        setOpen(false);
        setQuery('');
    }, [engine]);

    // hotkey when focus is on the host window (not inside the webview)
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

    // guest page's keydown never reaches this window (separate process), so
    // main forwards the shortcut here, tagged with the guest's webContents id
    useEffect(() => {
        return windowHandlers.onBrowserFindShortcut.listen(({ webContentsId }) => {
            const webview = webviewRef.current;
            if (!webview || webview.getWebContentsId() !== webContentsId) return;
            setOpen(true);
        });
    }, [webviewRef]);

    if (!open) return null;

    return <FindBarPanel engine={engine} query={query} setQuery={setQuery} onClose={close} inputRef={inputRef} />;
}
