import { useEffect, useState } from 'react';
import { tipcInvoker, windowHandlers } from './tipc-client';

const STORAGE_KEY = 'window.opacity';

// Keeps localStorage in sync with shortcut-driven opacity changes (Ctrl+I /
// Ctrl+D) regardless of which route is currently mounted — only one page is
// ever mounted at a time in this SPA, so a per-component listener alone
// would miss changes made while, say, Settings isn't the active route, and
// the next mount would push the stale stored value back and clobber it.
windowHandlers.onOpacityChanged.listen((data) => {
    localStorage.setItem(STORAGE_KEY, String(data.opacity));
});

export function useOpacitySetting() {
    const [opacity, setOpacity] = useState(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored === null ? 1 : Number(stored);
    });

    useEffect(() => {
        return windowHandlers.onOpacityChanged.listen((data) => {
            setOpacity(data.opacity);
        });
    }, []);

    useEffect(() => {
        localStorage.setItem(STORAGE_KEY, String(opacity));
        tipcInvoker.window.setOpacity({ opacity });
    }, [opacity]);

    return [opacity, setOpacity] as const;
}
