import { useEffect, useState } from 'react';
import { tipcInvoker } from './tipc-client';

const STORAGE_KEY = 'window.opacity';

export function useOpacitySetting() {
    const [opacity, setOpacity] = useState(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored === null ? 1 : Number(stored);
    });

    useEffect(() => {
        localStorage.setItem(STORAGE_KEY, String(opacity));
        tipcInvoker.window.setOpacity({ opacity });
    }, [opacity]);

    return [opacity, setOpacity] as const;
}
