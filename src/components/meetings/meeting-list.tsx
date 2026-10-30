import { IconMicrophone, IconRefresh, IconBrandYoutube } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { transcriptStore } from '@/lib/transcript-client';
import type { MeetingsState } from '@/lib/transcript-store';
import { cn } from '@/lib/utils';
import type { Meeting } from '@/types/transcript';

function when(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? ''
        : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function MeetingRow({ meeting, selected, disabled }: { meeting: Meeting; selected: boolean; disabled: boolean }) {
    const SourceIcon = meeting.source === 'youtube' ? IconBrandYoutube : IconMicrophone;
    return (
        <li>
            <button
                type="button"
                disabled={disabled}
                onClick={() => void transcriptStore.openMeeting(meeting.id)}
                className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                    selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                    disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
                )}
            >
                <span
                    className={cn(
                        'size-2 shrink-0 rounded-full',
                        meeting.status === 'live' ? 'animate-pulse bg-emerald-500' : 'bg-muted-foreground/40',
                    )}
                />
                <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{meeting.title || 'Untitled meeting'}</span>
                    <span className="block text-xs text-muted-foreground">
                        {when(meeting.startedAt ?? meeting.createdAt)}
                        {meeting.role === 'participant' && ' · Participant'}
                    </span>
                </span>
                {meeting.source && <SourceIcon className="size-4 shrink-0 text-muted-foreground" />}
            </button>
        </li>
    );
}

export function MeetingList({ state }: { state: MeetingsState }) {
    const { meetings, listLoading, listError, runningHere, speakingHere, meeting } = state;
    const locked = runningHere || speakingHere;
    return (
        <div className="flex min-h-0 flex-col">
            <div className="flex items-center justify-between px-3 pb-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent meetings</h2>
                <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label="Refresh meetings"
                    onClick={() => void transcriptStore.refreshMeetings()}
                >
                    <IconRefresh className={cn('size-4', listLoading && 'animate-spin')} />
                </Button>
            </div>
            {locked && (
                <p className="px-3 pb-2 text-xs text-muted-foreground">
                    {runningHere ? 'End the live meeting to open another one.' : 'Leave the meeting to open another one.'}
                </p>
            )}
            {listError && (
                <Alert variant="destructive" className="mx-2 mb-2 w-auto">
                    <AlertDescription className="space-y-1 text-xs">
                        <div>{listError}</div>
                        <div>
                            Is the backend running? Check its address in{' '}
                            <Link to="/settings/customization/backend" className="underline">
                                settings
                            </Link>
                            .
                        </div>
                    </AlertDescription>
                </Alert>
            )}
            {listLoading && meetings.length === 0 && !listError && (
                <div className="space-y-2 px-3">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                </div>
            )}
            {!listLoading && !listError && meetings.length === 0 && (
                <p className="px-3 py-4 text-sm text-muted-foreground">No meetings yet. Start one to see it here.</p>
            )}
            <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1">
                {meetings.map((m) => (
                    <MeetingRow
                        key={m.id}
                        meeting={m}
                        selected={meeting?.id === m.id}
                        disabled={locked && meeting?.id !== m.id}
                    />
                ))}
            </ul>
        </div>
    );
}
