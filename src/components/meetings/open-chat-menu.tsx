import { IconMessageCircle, IconRefresh } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useState, type CSSProperties } from 'react';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { meetingChatStore } from '@/lib/meeting-chat-client';
import { openChatIds, openExistingChat } from '@/lib/meeting-chat-actions';
import { formatChatTime, openableChats, type OpenableChat } from '@/lib/meeting-chat-labels';
import type { Meeting } from '@/types/transcript';

type Loaded = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; chats: OpenableChat[] };

/**
 * Lists the chats the meeting already has on the backend (including ones made on another
 * device) and opens the chosen one as a tab in /ai.
 */
export function OpenChatMenu({ meeting }: { meeting: Meeting }) {
    const navigate = useNavigate();
    const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });

    const load = async () => {
        setLoaded({ status: 'loading' });
        const result = await meetingChatStore.listChats(meeting.id);
        if (result.error !== undefined) {
            setLoaded({ status: 'error', message: result.error });
            return;
        }
        setLoaded({ status: 'ready', chats: openableChats(result.chats, meeting, openChatIds()) });
    };

    return (
        <DropdownMenu onOpenChange={(open) => open && void load()}>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                    <IconMessageCircle className="mr-1 size-4" />
                    Open chat
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
                <DropdownMenuLabel className="flex items-center justify-between text-xs">
                    Chats on this meeting
                    <button
                        type="button"
                        aria-label="Reload chats"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={(event) => {
                            event.preventDefault();
                            void load();
                        }}
                    >
                        <IconRefresh className="size-3.5" />
                    </button>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {loaded.status === 'loading' && (
                    <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
                        <Spinner className="size-4" />
                        Loading…
                    </div>
                )}
                {loaded.status === 'error' && (
                    <div className="px-2 py-2 text-sm text-destructive">Could not load chats: {loaded.message}</div>
                )}
                {loaded.status === 'ready' && loaded.chats.length === 0 && (
                    <div className="px-2 py-2 text-sm text-muted-foreground">No chats on this meeting yet.</div>
                )}
                {loaded.status === 'ready' &&
                    loaded.chats.map(({ chat, label, open }) => (
                        <DropdownMenuItem
                            key={chat.id}
                            onClick={() => {
                                openExistingChat(meeting, chat);
                                void navigate({ to: '/ai' });
                            }}
                        >
                            <span className="min-w-0 flex-1">
                                <span className="block truncate">{label}</span>
                                <span className="block text-xs text-muted-foreground">{formatChatTime(chat.createdAt)}</span>
                            </span>
                            {open && <span className="shrink-0 text-xs text-muted-foreground">open</span>}
                        </DropdownMenuItem>
                    ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
