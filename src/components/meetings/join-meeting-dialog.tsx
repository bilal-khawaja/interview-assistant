import { useEffect, useState } from 'react';
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
import { Switch } from '@/components/ui/switch';
import { parseInviteToken } from '@/lib/invite-link';
import { transcriptStore } from '@/lib/transcript-client';
import type { MeetingsState } from '@/lib/transcript-store';
import { useMicrophones } from '@/lib/use-microphones';

export function JoinMeetingDialog({
    open,
    onOpenChange,
    state,
    initialLink = '',
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    state: MeetingsState;
    /** A link to start from, such as one the operating system opened the app with. */
    initialLink?: string;
}) {
    const [link, setLink] = useState(initialLink);
    useEffect(() => {
        if (open && initialLink) setLink(initialLink);
    }, [open, initialLink]);
    const [speak, setSpeak] = useState(true);
    const { devices, deviceId, setDeviceId, error: devicesError } = useMicrophones(open && speak);

    useEffect(() => {
        if (open) transcriptStore.clearError();
    }, [open]);

    const validLink = parseInviteToken(link) !== null;
    const canJoin = !state.joining && validLink && (!speak || devices.length > 0);

    const submit = async () => {
        const joined = await transcriptStore.joinMeeting(link, { speak, micDeviceId: deviceId || undefined });
        if (joined) {
            onOpenChange(false);
            setLink('');
        }
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !state.joining && onOpenChange(next)}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Join a meeting</DialogTitle>
                    <DialogDescription>Paste the meeting link you were sent.</DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                    <div className="space-y-1.5">
                        <Label htmlFor="join-link">Meeting link</Label>
                        <Input
                            id="join-link"
                            autoFocus
                            value={link}
                            placeholder="interview-assistant://join/…"
                            onChange={(e) => setLink(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && canJoin) void submit();
                            }}
                        />
                    </div>

                    <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
                        <div className="space-y-0.5">
                            <Label htmlFor="join-speak">Share my microphone</Label>
                            <p className="text-xs text-muted-foreground">
                                What you say is transcribed and shown to everyone in the meeting, under your name.
                                Turn this off to follow along without speaking.
                            </p>
                        </div>
                        <Switch id="join-speak" checked={speak} onCheckedChange={setSpeak} />
                    </div>

                    {speak && (
                        <div className="space-y-1.5">
                            <Label htmlFor="join-mic">Microphone</Label>
                            <Select value={deviceId} onValueChange={setDeviceId} disabled={devices.length === 0}>
                                <SelectTrigger id="join-mic">
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
                        </div>
                    )}
                </div>

                {state.error && (
                    <Alert variant="destructive">
                        <AlertDescription>{state.error}</AlertDescription>
                    </Alert>
                )}

                <DialogFooter>
                    <Button variant="outline" disabled={state.joining} onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button disabled={!canJoin} onClick={() => void submit()}>
                        {state.joining && <Spinner className="mr-2 size-4" />}
                        {state.joining ? 'Joining…' : 'Join meeting'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
