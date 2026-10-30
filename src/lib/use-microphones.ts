import { useEffect, useState } from 'react';
import { listMicrophones, type MicDevice } from './mic-capture';
import { transcriptStore } from './transcript-client';

/**
 * The microphones that can be picked while `active` is true, re-read whenever a headset is
 * plugged in or out. The saved choice is kept if it is still there, else the first device.
 */
export function useMicrophones(active: boolean) {
    const [devices, setDevices] = useState<MicDevice[]>([]);
    const [deviceId, setDeviceId] = useState('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!active) return;
        let cancelled = false;
        const refresh = async () => {
            try {
                const found = await listMicrophones();
                if (cancelled) return;
                setDevices(found);
                setError(null);
                setDeviceId((current) => {
                    if (current && found.some((d) => d.deviceId === current)) return current;
                    const saved = transcriptStore.savedMicDeviceId;
                    if (saved && found.some((d) => d.deviceId === saved)) return saved;
                    return found[0]?.deviceId ?? '';
                });
            } catch {
                if (!cancelled) setError('Could not list microphones.');
            }
        };
        void refresh();
        navigator.mediaDevices.addEventListener('devicechange', refresh);
        return () => {
            cancelled = true;
            navigator.mediaDevices.removeEventListener('devicechange', refresh);
        };
    }, [active]);

    return { devices, deviceId, setDeviceId, error };
}
