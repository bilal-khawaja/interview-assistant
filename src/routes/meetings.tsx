import { useState, type CSSProperties } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import {
    IconBrandYoutube,
    IconMessageChatbot,
    IconMicrophone,
    IconPlayerStopFilled,
    IconPlus,
    IconX,
} from '@tabler/icons-react';
import { MeetingList } from '@/components/meetings/meeting-list';
import { StartMeetingDialog } from '@/components/meetings/start-meeting-dialog';
import { StatusChip } from '@/components/meetings/status-chip';
import { TranscriptView } from '@/components/meetings/transcript-view';
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
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Spinner } from '@/components/ui/spinner';
import { AppSidebar, AppSidebarInset } from '@/layout/sidebar';
import { OpenChatMenu } from '@/components/meetings/open-chat-menu';
import { startMeetingChat } from '@/lib/meeting-chat-actions';
import { transcriptStore, useMeetings } from '@/lib/transcript-client';

export const Route = createFileRoute('/meetings')({
    component: MeetingsPage,
});

function MicMeter({ level }: { level: number }) {
    return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="mic-meter">
            <IconMicrophone className="size-4" />
            <span className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
                <span
                    className="block h-full rounded-full bg-primary transition-[width] duration-100"
                    style={{ width: `${Math.round(level * 100)}%` }}
                />
            </span>
            Listening
        </div>
    );
}

function MeetingsPage() {
    const state = useMeetings();
    const [startOpen, setStartOpen] = useState(false);
    const [endOpen, setEndOpen] = useState(false);
    const [chatStarting, setChatStarting] = useState(false);
    const [chatError, setChatError] = useState<string | null>(null);
    const navigate = useNavigate();
    const { meeting, runningHere } = state;

    const startChat = async () => {
        if (!meeting || chatStarting) return;
        setChatStarting(true);
        setChatError(null);
        const error = await startMeetingChat(meeting);
        setChatStarting(false);
        if (error) setChatError(error);
        else void navigate({ to: '/ai' });
    };

    const trouble =
        state.status === 'degraded' || state.status === 'reconnecting' ? (state.detail ?? 'Connection problem') : null;
    const SourceIcon = meeting?.source === 'youtube' ? IconBrandYoutube : IconMicrophone;

    return (
        <SidebarProvider style={{ '--sidebar-width': '18rem' } as CSSProperties}>
            <AppSidebar />
            <AppSidebarInset className="flex h-screen min-w-0 flex-1 flex-col overflow-hidden bg-background">
                {/* The root layout lays a window-drag strip over the top 2rem; without no-drag the
                    upper part of these buttons would drag the window instead of being clickable. */}
                <div
                    className="flex shrink-0 items-center gap-2 border-b px-2 py-2"
                    style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                >
                    <SidebarTrigger />
                    <h1 className="text-base font-semibold">Meetings</h1>
                    <div className="ml-auto flex items-center gap-2">
                        {meeting && <OpenChatMenu key={meeting.id} meeting={meeting} />}
                        {meeting?.status === 'live' && (
                            <Button variant="outline" size="sm" disabled={chatStarting} onClick={() => void startChat()}>
                                {chatStarting ? <Spinner className="mr-2 size-4" /> : <IconMessageChatbot className="mr-1 size-4" />}
                                Start chat
                            </Button>
                        )}
                        {runningHere ? (
                            <Button
                                variant="destructive"
                                size="sm"
                                className="text-white"
                                disabled={state.ending}
                                onClick={() => setEndOpen(true)}
                            >
                                {state.ending ? <Spinner className="mr-2 size-4" /> : <IconPlayerStopFilled className="mr-1 size-4" />}
                                {state.ending ? 'Ending…' : 'End meeting'}
                            </Button>
                        ) : (
                            <Button size="sm" disabled={state.starting} onClick={() => setStartOpen(true)}>
                                <IconPlus className="mr-1 size-4" />
                                Start meeting
                            </Button>
                        )}
                    </div>
                </div>

                {chatError && (
                    <Alert variant="destructive" className="m-3 w-auto">
                        <AlertDescription className="flex items-start justify-between gap-2">
                            <span>Could not start a chat: {chatError}</span>
                            <button type="button" className="text-xs underline" onClick={() => setChatError(null)}>
                                Dismiss
                            </button>
                        </AlertDescription>
                    </Alert>
                )}

                {state.backend === 'down' && (
                    <Alert variant="destructive" className="m-3 w-auto">
                        <AlertDescription className="flex flex-wrap items-center gap-2">
                            <span>
                                Cannot reach the transcript backend{state.backendError ? `: ${state.backendError}` : ''}.
                            </span>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                    void transcriptStore.checkBackend().then(() => transcriptStore.refreshMeetings());
                                }}
                            >
                                Retry
                            </Button>
                            <Link to="/settings/customization/backend" className="text-sm underline">
                                Change address
                            </Link>
                        </AlertDescription>
                    </Alert>
                )}

                <div className="grid min-h-0 flex-1 grid-cols-[17rem_1fr]">
                    <aside className="flex min-h-0 flex-col border-r py-3">
                        <MeetingList state={state} />
                    </aside>

                    <section className="flex min-h-0 min-w-0 flex-col">
                        {meeting ? (
                            <>
                                <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
                                    <div className="min-w-0">
                                        <h2 className="truncate text-sm font-semibold">{meeting.title || 'Untitled meeting'}</h2>
                                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                            {meeting.source && <SourceIcon className="size-3.5" />}
                                            {new Date(meeting.startedAt ?? meeting.createdAt).toLocaleString()}
                                        </div>
                                    </div>
                                    <StatusChip meeting={meeting} status={state.status} />
                                    {state.micActive && <MicMeter level={state.micLevel} />}
                                    {!runningHere && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="ml-auto size-7"
                                            aria-label="Close transcript"
                                            onClick={() => void transcriptStore.closeMeeting()}
                                        >
                                            <IconX className="size-4" />
                                        </Button>
                                    )}
                                </div>

                                {trouble && (
                                    <Alert className="mx-4 mt-3 w-auto">
                                        <AlertDescription>
                                            {state.status === 'degraded'
                                                ? `The server is catching up, so new lines may be late (${trouble}).`
                                                : `Connection lost, retrying (${trouble}). Nothing is lost: the transcript resumes where it stopped.`}
                                        </AlertDescription>
                                    </Alert>
                                )}
                                {state.error && (
                                    <Alert variant="destructive" className="mx-4 mt-3 w-auto">
                                        <AlertDescription className="flex items-start justify-between gap-2">
                                            <span>{state.error}</span>
                                            <button
                                                type="button"
                                                className="text-xs underline"
                                                onClick={() => transcriptStore.clearError()}
                                            >
                                                Dismiss
                                            </button>
                                        </AlertDescription>
                                    </Alert>
                                )}

                                <TranscriptView
                                    segments={state.segments}
                                    emptyHint={
                                        meeting.status === 'ended'
                                            ? 'This meeting has no transcript.'
                                            : 'Listening… the transcript appears here a few seconds after someone speaks.'
                                    }
                                />
                            </>
                        ) : (
                            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                                <IconMicrophone className="size-10 text-muted-foreground" />
                                <h2 className="text-lg font-semibold">No meeting open</h2>
                                <p className="max-w-sm text-sm text-muted-foreground">
                                    Start a meeting to see its live transcript, or pick a recent one from the list.
                                </p>
                                {state.error && (
                                    <Alert variant="destructive" className="max-w-sm">
                                        <AlertDescription>{state.error}</AlertDescription>
                                    </Alert>
                                )}
                                <Button disabled={state.starting} onClick={() => setStartOpen(true)}>
                                    <IconPlus className="mr-1 size-4" />
                                    Start meeting
                                </Button>
                            </div>
                        )}
                    </section>
                </div>

                <StartMeetingDialog open={startOpen} onOpenChange={setStartOpen} state={state} />

                <Dialog open={endOpen} onOpenChange={setEndOpen}>
                    <DialogContent className="max-w-sm">
                        <DialogHeader>
                            <DialogTitle>End this meeting?</DialogTitle>
                            <DialogDescription>
                                Transcription stops and the meeting cannot be resumed. The transcript so far is kept.
                            </DialogDescription>
                        </DialogHeader>
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setEndOpen(false)}>
                                Keep going
                            </Button>
                            <Button
                                variant="destructive"
                                className="text-white"
                                onClick={() => {
                                    setEndOpen(false);
                                    void transcriptStore.endMeeting();
                                }}
                            >
                                End meeting
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </AppSidebarInset>
        </SidebarProvider>
    );
}
