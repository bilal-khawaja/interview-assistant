import { useEffect, useRef } from 'react';
import { IconAlertTriangle } from '@tabler/icons-react';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { ChatFindBar } from '@/components/chat-find-bar';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PromptInputBox } from '@/components/ui/ai-prompt-box';
import { ScrollArea } from '@/components/ui/scroll-area';
import { meetingChatStore, useMeetingChat } from '@/lib/meeting-chat-client';
import type { ChatViewMessage } from '@/lib/meeting-chat-store';
import { MODELS } from '@/lib/models';
import { cn } from '@/lib/utils';

/** The model the backend answers meeting chats with (CHAT_MODEL there). Shown, not selectable. */
const MEETING_CHAT_MODEL = 'gpt-4.1-mini';
const MODEL_OPTIONS = MODELS.map((m) => ({ label: m.label, value: m.value }));
const NOTHING = () => undefined;

function MessageRow({ message, onRetry }: { message: ChatViewMessage; onRetry: () => void }) {
    if (message.role === 'user') {
        return (
            <div className="text-right">
                <span
                    className={cn(
                        'inline-block max-w-full whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-2 text-left text-sm text-foreground',
                        message.delivery === 'sending' && 'opacity-60',
                        message.delivery === 'failed' && 'ring-1 ring-destructive',
                    )}
                >
                    {message.content}
                </span>
                {message.delivery === 'failed' && (
                    <div className="mt-1 flex items-center justify-end gap-2 text-xs text-destructive">
                        <IconAlertTriangle className="size-3.5" />
                        Not sent
                        <button type="button" className="underline" onClick={onRetry}>
                            Retry
                        </button>
                    </div>
                )}
            </div>
        );
    }
    if (message.role === 'system') {
        return <p className="text-center text-xs text-muted-foreground">{message.content}</p>;
    }
    return (
        <div className="break-words text-sm leading-normal text-foreground">
            <MarkdownRenderer content={message.content} isStreaming={false} />
        </div>
    );
}

/** One backend chat of a meeting. Its messages live on the backend; this only shows them. */
export function MeetingChatPane({ meetingId, chatId }: { meetingId: string; chatId: string }) {
    const chat = useMeetingChat(chatId);
    const messagesRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const messageCount = chat?.messages.length ?? 0;
    const pending = chat?.pending ?? false;

    // The chat is normally opened by whoever created the tab; this covers a tab that outlived
    // the window (a reload, or a restart) and so has no open chat behind it yet.
    useEffect(() => {
        if (!meetingChatStore.getState().chats[chatId]) void meetingChatStore.open(meetingId, chatId);
    }, [meetingId, chatId]);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ block: 'end' });
    }, [messageCount, pending]);

    const trouble =
        chat?.status === 'degraded' || chat?.status === 'reconnecting' ? (chat.detail ?? 'Connection problem') : null;
    const isEmpty = messageCount === 0 && !pending;

    return (
        <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
            <ChatFindBar containerRef={messagesRef} />
            {trouble && (
                <Alert className="mx-4 mt-3 w-auto">
                    <AlertDescription>
                        {chat?.status === 'degraded'
                            ? `The server is catching up, so replies may be late (${trouble}).`
                            : `Connection lost, retrying (${trouble}). Nothing is lost: the chat resumes where it stopped.`}
                    </AlertDescription>
                </Alert>
            )}
            <ScrollArea className={cn('mt-2 flex-1', isEmpty && 'flex items-center justify-center')}>
                <div ref={messagesRef} className="p-4 sm:p-6">
                    {isEmpty ? (
                        <div className="pointer-events-none mx-auto max-w-sm cursor-default select-none text-center">
                            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Ask about this meeting</h1>
                            <p className="mt-2 text-sm text-muted-foreground">
                                {chat ? 'The assistant follows the transcript as it happens.' : 'Connecting…'}
                            </p>
                        </div>
                    ) : (
                        <div className="mx-auto w-full max-w-2xl space-y-6">
                            {chat?.messages.map((message) => (
                                <MessageRow
                                    key={message.id}
                                    message={message}
                                    onRetry={() => void meetingChatStore.retry(chatId, message.id)}
                                />
                            ))}
                            {pending && (
                                <div className="text-sm">
                                    <Shimmer>Generating Response...</Shimmer>
                                </div>
                            )}
                            {chat?.error && (
                                <Alert variant="destructive">
                                    <AlertDescription>{chat.error}</AlertDescription>
                                </Alert>
                            )}
                            <div ref={bottomRef} />
                        </div>
                    )}
                </div>
            </ScrollArea>

            <div className="shrink-0 flex justify-center w-full p-4 sm:p-6 pt-0">
                <div className="w-full max-w-[90%] sm:max-w-md md:max-w-lg lg:max-w-2xl min-w-[260px] mx-auto">
                    {/* Same box as /ai. A message sent while an answer is pending is queued by the backend. */}
                    <PromptInputBox
                        onSend={(text) => void meetingChatStore.send(chatId, text)}
                        placeholder="Ask about the meeting..."
                        models={MODEL_OPTIONS}
                        model={MEETING_CHAT_MODEL}
                        onModelChange={NOTHING}
                        modelDisabled
                        attachDisabled
                        webSearch={false}
                        onWebSearchChange={NOTHING}
                        webSearchDisabled
                        reasoning={false}
                        onReasoningChange={NOTHING}
                        reasoningDisabled
                        reasoningEffort="medium"
                        onReasoningEffortChange={NOTHING}
                    />
                </div>
            </div>
        </div>
    );
}
