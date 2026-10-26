import { useEffect, useState } from 'react';
import { IconBrandYoutube, IconMicrophone } from '@tabler/icons-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { listMicrophones, type MicDevice } from '@/lib/mic-capture';
import { transcriptStore } from '@/lib/transcript-client';
import type { MeetingsState } from '@/lib/transcript-store';
import { cn } from '@/lib/utils';
import type { MeetingSource } from '@/types/transcript';

const DEFAULT_YOUTUBE_SECONDS = 120;
const MAX_YOUTUBE_SECONDS = 600;

function SourceCard({
    active,
    onClick,
    icon: Icon,
    title,
    text,
}: {
    active: boolean;
    onClick: () => void;
    icon: typeof IconMicrophone;
    title: string;
    text: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={cn(
                'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
                active ? 'border-primary bg-accent' : 'hover:bg-accent/50',
            )}
        >
            <Icon className="size-5" />
            <span className="text-sm font-medium">{title}</span>
            <span className="text-xs text-muted-foreground">{text}</span>
        </button>
    );
}

export function StartMeetingDialog({
    open,
    onOpenChange,
    state,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    state: MeetingsState;
}) {
    const [source, setSource] = useState<MeetingSource>('live');
    const [title, setTitle] = useState('');
    const [url, setUrl] = useState('');
    const [seconds, setSeconds] = useState(String(DEFAULT_YOUTUBE_SECONDS));
    const [devices, setDevices] = useState<MicDevice[]>([]);
    const [deviceId, setDeviceId] = useState('');
    const [devicesError, setDevicesError] = useState<string | null>(null);

    // Re-read the microphones whenever the dialog opens or a headset is plugged in or out.
    useEffect(() => {
        if (!open || source !== 'live') return;
        let cancelled = false;
        const refresh = async () => {
            try {
                const found = await listMicrophones();
                if (cancelled) return;
                setDevices(found);
                setDevicesError(null);
                setDeviceId((current) => {
                    if (current && found.some((d) => d.deviceId === current)) return current;
                    const saved = transcriptStore.savedMicDeviceId;
                    if (saved && found.some((d) => d.deviceId === saved)) return saved;
                    return found[0]?.deviceId ?? '';
                });
            } catch {
                if (!cancelled) setDevicesError('Could not list microphones.');
            }
        };
        void refresh();
        navigator.mediaDevices.addEventListener('devicechange', refresh);
        return () => {
            cancelled = true;
            navigator.mediaDevices.removeEventListener('devicechange', refresh);
        };
    }, [open, source]);

    useEffect(() => {
        if (open) transcriptStore.clearError();
    }, [open]);

    const youtubeSeconds = Number(seconds);
    const youtubeValid =
        url.trim().length > 0 &&
        Number.isInteger(youtubeSeconds) &&
        youtubeSeconds >= 1 &&
        youtubeSeconds <= MAX_YOUTUBE_SECONDS;
    const canStart = !state.starting && (source === 'live' ? devices.length > 0 : youtubeValid);

    const submit = async () => {
        const trimmed = title.trim() || undefined;
        const started =
            source === 'live'
                ? await transcriptStore.startMeeting({ source: 'live', title: trimmed }, deviceId || undefined)
                : await transcriptStore.startMeeting({
                      source: 'youtube',
                      url: url.trim(),
                      title: trimmed,
                      maxSeconds: youtubeSeconds,
                  });
        if (started) {
            onOpenChange(false);
            setTitle('');
        }
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !state.starting && onOpenChange(next)}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Start a meeting</DialogTitle>
                    <DialogDescription>Choose what to transcribe. You can end the meeting at any time.</DialogDescription>
                </DialogHeader>

                <div className="grid grid-cols-2 gap-3">
                    <SourceCard
                        active={source === 'live'}
                        onClick={() => setSource('live')}
                        icon={IconMicrophone}
                        title="Realtime speech-to-text"
                        text="Transcribe your microphone or headset live."
                    />
                    <SourceCard
                        active={source === 'youtube'}
                        onClick={() => setSource('youtube')}
                        icon={IconBrandYoutube}
                        title="YouTube audio test"
                        text="Transcribe a video's audio to try things out."
                    />
                </div>

                <div className="space-y-3">
                    <div className="space-y-1.5">
                        <Label htmlFor="meeting-title">Title (optional)</Label>
                        <Input
                            id="meeting-title"
                            value={title}
                            maxLength={200}
                            placeholder={source === 'live' ? 'Live meeting' : 'Defaults to the video link'}
                            onChange={(e) => setTitle(e.target.value)}
                        />
                    </div>

                    {source === 'live' ? (
                        <div className="space-y-1.5">
                            <Label htmlFor="meeting-mic">Microphone</Label>
                            <Select value={deviceId} onValueChange={setDeviceId} disabled={devices.length === 0}>
                                <SelectTrigger id="meeting-mic">
                                    <SelectValue placeholder={devicesError ?? 'No microphone found'} />
                                </SelectTrigger>
                                <SelectContent>
                                    {devices.map((d) => (
                                        <SelectItem key={d.deviceId} value={d.deviceId}>
                                            {d.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">
                                Headsets appear here once connected. Plug yours in and it shows up in the list.
                            </p>
                        </div>
                    ) : (
                        <>
                            <div className="space-y-1.5">
                                <Label htmlFor="meeting-url">YouTube link</Label>
                                <Input
                                    id="meeting-url"
                                    value={url}
                                    placeholder="https://www.youtube.com/watch?v=…"
                                    onChange={(e) => setUrl(e.target.value)}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="meeting-seconds">Transcribe the first (seconds)</Label>
                                <Input
                                    id="meeting-seconds"
                                    inputMode="numeric"
                                    className="w-32"
                                    value={seconds}
                                    onChange={(e) => setSeconds(e.target.value.replace(/\D/g, ''))}
                                />
                                <p className="text-xs text-muted-foreground">Up to {MAX_YOUTUBE_SECONDS} seconds.</p>
                            </div>
                        </>
                    )}
                </div>

                {state.error && (
                    <Alert variant="destructive">
                        <AlertDescription>{state.error}</AlertDescription>
                    </Alert>
                )}

                <DialogFooter>
                    <Button variant="outline" disabled={state.starting} onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button disabled={!canStart} onClick={() => void submit()}>
                        {state.starting && <Spinner className="mr-2 size-4" />}
                        {state.starting ? 'Starting…' : 'Start meeting'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
