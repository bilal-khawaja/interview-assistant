import { useEffect, useState } from 'react';
import { tipcInvoker, windowHandlers } from './tipc-client';

export function useClickThroughSetting() {
    const [enabled, setEnabled] = useState(false);

    useEffect(() => {
        return windowHandlers.onClickThroughChanged.listen((data) => {
            setEnabled(data.enabled);
        });
    }, []);

    useEffect(() => {
        tipcInvoker.window.setClickThrough({ enabled });
    }, [enabled]);

    return [enabled, setEnabled] as const;
}
