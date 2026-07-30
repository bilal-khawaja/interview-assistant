import { useEffect, useState } from 'react';

const STORAGE_KEY = 'ai.streamResponse';

export function useStreamSetting() {
    const [stream, setStream] = useState(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored === null ? true : stored === 'true';
    });

    useEffect(() => {
        localStorage.setItem(STORAGE_KEY, String(stream));
    }, [stream]);

    return [stream, setStream] as const;
}
