import { useEffect, useState } from 'react';

const STORAGE_KEY = 'ai.reasoning';

export function useReasoningSetting() {
    const [reasoning, setReasoning] = useState(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored === null ? false : stored === 'true';
    });

    useEffect(() => {
        localStorage.setItem(STORAGE_KEY, String(reasoning));
    }, [reasoning]);

    return [reasoning, setReasoning] as const;
}
