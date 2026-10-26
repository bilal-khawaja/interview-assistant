import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconArrowDown, IconPlugConnectedX } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { formatClock, groupSegments, speakerIndex } from '@/lib/transcript-format';
import type { TranscriptSegment } from '@/types/transcript';

const STICK_THRESHOLD_PX = 48;
const SPEAKER_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

function colorFor(key: string | null): string {
    const index = speakerIndex(key) ?? 0;
    return SPEAKER_COLORS[index % SPEAKER_COLORS.length]!;
}

/**
 * The transcript as speaking turns. It follows the newest line while you are at the bottom
 * and stops following as soon as you scroll up to read, offering a jump back instead.
 */
export function TranscriptView({
    segments,
    emptyHint,
}: {
    segments: readonly TranscriptSegment[];
    emptyHint: string;
}) {
    const groups = useMemo(() => groupSegments(segments), [segments]);
    const scroller = useRef<HTMLDivElement>(null);
    const [following, setFollowing] = useState(true);
    const [unseen, setUnseen] = useState(0);
    const seenCount = useRef(0);

    const toBottom = () => {
        const el = scroller.current;
        if (el) el.scrollTop = el.scrollHeight;
    };

    useLayoutEffect(() => {
        if (following) {
            toBottom();
            seenCount.current = segments.length;
            setUnseen(0);
        } else {
            setUnseen(Math.max(0, segments.length - seenCount.current));
        }
    }, [segments.length, following]);

    // A different transcript (another meeting, or a reset) starts at the bottom again.
    const first = segments[0]?.seq;
    useEffect(() => {
        setFollowing(true);
        seenCount.current = 0;
    }, [first]);

    const onScroll = () => {
        const el = scroller.current;
        if (!el) return;
        setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX);
    };

    return (
        <div className="relative min-h-0 flex-1">
            <div ref={scroller} onScroll={onScroll} className="h-full space-y-4 overflow-y-auto px-4 py-4" data-testid="transcript">
                {groups.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">{emptyHint}</p>}
                {groups.map((group) =>
                    group.kind === 'gap' ? (
                        <div key={`g${group.id}`} className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="h-px flex-1 bg-border" />
                            <IconPlugConnectedX className="size-3.5" />
                            Connection lost, some speech may be missing ({formatClock(group.startMs)}–{formatClock(group.endMs)})
                            <span className="h-px flex-1 bg-border" />
                        </div>
                    ) : (
                        <div key={`s${group.id}`} className="border-l-2 pl-3" style={{ borderLeftColor: colorFor(group.speakerKey) }}>
                            <div className="mb-0.5 flex items-baseline gap-2 text-xs">
                                <span className="font-semibold text-foreground">{group.name}</span>
                                <span className="tabular-nums text-muted-foreground">{formatClock(group.startMs)}</span>
                            </div>
                            <p className="text-sm leading-relaxed text-foreground">
                                {group.segments.map((s) => s.text.trim()).join(' ')}
                            </p>
                        </div>
                    ),
                )}
            </div>
            {!following && (
                <Button
                    size="sm"
                    variant="secondary"
                    className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md"
                    onClick={() => {
                        toBottom();
                        setFollowing(true);
                    }}
                >
                    <IconArrowDown className="mr-1 size-4" />
                    {unseen > 0 ? `${unseen} new` : 'Jump to latest'}
                </Button>
            )}
        </div>
    );
}
