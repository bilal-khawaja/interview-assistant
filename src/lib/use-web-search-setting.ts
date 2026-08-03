import { useEffect, useState } from 'react';

const STORAGE_KEY = 'ai.webSearch';

export function useWebSearchSetting() {
    const [webSearch, setWebSearch] = useState(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored === null ? false : stored === 'true';
    });

    useEffect(() => {
        localStorage.setItem(STORAGE_KEY, String(webSearch));
    }, [webSearch]);

    return [webSearch, setWebSearch] as const;
}
