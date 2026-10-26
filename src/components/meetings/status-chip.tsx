import { cn } from '@/lib/utils';
import type { Meeting, StreamStatus } from '@/types/transcript';

type Tone = 'good' | 'warn' | 'bad' | 'idle';

function describe(meeting: Meeting, status: StreamStatus | null): { label: string; tone: Tone; pulse?: boolean } {
    if (status === 'ended' || (meeting.status === 'ended' && status === 'live')) {
        return { label: meeting.status === 'ended' && status === 'live' ? 'Ended · loaded' : 'Ended', tone: 'idle' };
    }
    switch (status) {
        case 'live':
            return { label: 'Live', tone: 'good', pulse: true };
        case 'degraded':
            return { label: 'Server catching up', tone: 'warn' };
        case 'reconnecting':
            return { label: 'Reconnecting…', tone: 'warn' };
        case 'connecting':
        case null:
            return { label: 'Connecting…', tone: 'idle' };
    }
}

const TONES: Record<Tone, string> = {
    good: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    warn: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    bad: 'bg-destructive/15 text-destructive',
    idle: 'bg-muted text-muted-foreground',
};

const DOTS: Record<Tone, string> = {
    good: 'bg-emerald-500',
    warn: 'bg-amber-500',
    bad: 'bg-destructive',
    idle: 'bg-muted-foreground/60',
};

export function StatusChip({ meeting, status }: { meeting: Meeting; status: StreamStatus | null }) {
    const { label, tone, pulse } = describe(meeting, status);
    return (
        <span
            className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium', TONES[tone])}
            data-testid="status-chip"
        >
            <span className={cn('size-1.5 rounded-full', DOTS[tone], pulse && 'animate-pulse')} />
            {label}
        </span>
    );
}
