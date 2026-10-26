import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { SettingField, SettingsPage, SettingsSection } from '@/components/settings-page';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { transcriptStore, useMeetings } from '@/lib/transcript-client';

export const Route = createFileRoute('/settings/customization/backend')({
    component: BackendSettings,
});

function BackendSettings() {
    const state = useMeetings();
    const [url, setUrl] = useState(state.backendUrl);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

    const save = async () => {
        setBusy(true);
        setMessage(null);
        const error = await transcriptStore.setBackendUrl(url);
        setBusy(false);
        if (error) {
            setMessage({ ok: false, text: error });
            return;
        }
        const reachable = transcriptStore.getState().backend === 'ok';
        setMessage({
            ok: reachable,
            text: reachable ? 'Saved. The backend is reachable.' : 'Saved, but the backend did not answer at that address.',
        });
        setUrl(transcriptStore.getState().backendUrl);
    };

    const test = async () => {
        setBusy(true);
        setMessage(null);
        const ok = await transcriptStore.checkBackend();
        setBusy(false);
        setMessage({
            ok,
            text: ok ? 'The backend is reachable.' : (transcriptStore.getState().backendError ?? 'Cannot reach the backend.'),
        });
    };

    return (
        <SettingsPage title="Meetings Backend" description="Where the transcript server runs.">
            <SettingsSection>
                <SettingField
                    label="Backend address"
                    htmlFor="backend-url"
                    description="The server that records and streams meeting transcripts."
                >
                    <Input
                        id="backend-url"
                        value={url}
                        placeholder="http://localhost:3000"
                        onChange={(e) => setUrl(e.target.value)}
                    />
                </SettingField>
                <div className="flex items-center gap-3 text-sm">
                    <span
                        className={
                            state.backend === 'ok'
                                ? 'size-2 rounded-full bg-emerald-500'
                                : state.backend === 'down'
                                  ? 'size-2 rounded-full bg-destructive'
                                  : 'size-2 rounded-full bg-muted-foreground/50'
                        }
                    />
                    <span className="text-muted-foreground">
                        {state.backend === 'ok' ? 'Connected' : state.backend === 'down' ? 'Not reachable' : 'Not checked yet'}
                    </span>
                </div>
            </SettingsSection>
            {message && (
                <Alert variant={message.ok ? 'default' : 'destructive'}>
                    <AlertDescription>{message.text}</AlertDescription>
                </Alert>
            )}
            <div className="flex justify-end gap-2">
                <Button variant="outline" disabled={busy} onClick={() => void test()}>
                    Test connection
                </Button>
                <Button disabled={busy || !url.trim()} onClick={() => void save()}>
                    {busy && <Spinner className="mr-2 size-4" />}
                    Save
                </Button>
            </div>
        </SettingsPage>
    );
}
