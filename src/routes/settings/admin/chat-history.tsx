import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { IconTrash } from '@tabler/icons-react';
import { SettingsPage } from '@/components/settings-page';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useChatTabsStore } from '@/lib/chat-tabs-store';

export const Route = createFileRoute('/settings/admin/chat-history')({
    component: ChatHistory,
});

// The app has no accounts yet, so every exchange belongs to the local user.
const LOCAL_USER = 'Local user';

type Exchange = {
    id: string;
    tabId: string;
    index: number;
    user: string;
    prompt: string;
    response: string;
    sentAt: number | null;
};

function formatSentAt(sentAt: number | null): string {
    return sentAt ? new Date(sentAt).toLocaleString() : '—';
}

/** Collapses whitespace so multi-line text previews on a single line. */
function preview(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function ChatHistory() {
    const tabs = useChatTabsStore((s) => s.tabs);
    const deleteExchange = useChatTabsStore((s) => s.deleteExchange);
    const [openId, setOpenId] = useState<string | null>(null);

    const exchanges = useMemo(() => {
        const rows: Exchange[] = [];
        for (const tab of tabs) {
            if (tab.type !== 'chat') continue;
            tab.messages.forEach((message, index) => {
                if (message.role !== 'user') return;
                const reply = tab.messages[index + 1];
                rows.push({
                    id: `${tab.id}:${index}`,
                    tabId: tab.id,
                    index,
                    user: LOCAL_USER,
                    prompt: message.content,
                    response: reply?.role === 'assistant' ? reply.content : '',
                    sentAt: message.sentAt ?? null,
                });
            });
        }
        return rows.sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0));
    }, [tabs]);

    const selected = exchanges.find((row) => row.id === openId) ?? null;

    return (
        <SettingsPage wide title="Chat History" description="Every prompt and response from your open chat tabs. Click a row to read it in full.">
            <Card className="overflow-hidden">
                <Table className="table-fixed">
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-36">User</TableHead>
                            <TableHead className="w-[30%]">Prompt</TableHead>
                            <TableHead className="w-[40%]">Response</TableHead>
                            <TableHead className="w-44">Sent at</TableHead>
                            <TableHead className="w-14" />
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {exchanges.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                                    No chats yet.
                                </TableCell>
                            </TableRow>
                        ) : (
                            exchanges.map((row) => (
                                <TableRow
                                    key={row.id}
                                    tabIndex={0}
                                    className="cursor-pointer"
                                    onClick={() => setOpenId(row.id)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            setOpenId(row.id);
                                        }
                                    }}
                                >
                                    <TableCell className="truncate">{row.user}</TableCell>
                                    <TableCell className="truncate">{preview(row.prompt)}</TableCell>
                                    <TableCell className="truncate text-muted-foreground">
                                        {preview(row.response) || '—'}
                                    </TableCell>
                                    <TableCell className="truncate text-muted-foreground">
                                        {formatSentAt(row.sentAt)}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="size-8 text-muted-foreground hover:text-destructive"
                                            aria-label="Delete exchange"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                deleteExchange(row.tabId, row.index);
                                            }}
                                            onKeyDown={(e) => e.stopPropagation()}
                                        >
                                            <IconTrash className="size-4" />
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </Card>

            <Dialog open={selected !== null} onOpenChange={(open) => !open && setOpenId(null)}>
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Conversation</DialogTitle>
                        <DialogDescription>
                            {selected?.user} · {formatSentAt(selected?.sentAt ?? null)}
                        </DialogDescription>
                    </DialogHeader>
                    <ScrollArea className="max-h-[60vh]">
                        <div className="space-y-4 pr-3">
                            <div className="space-y-1">
                                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Prompt</h3>
                                <p className="whitespace-pre-wrap break-words text-sm">{selected?.prompt}</p>
                            </div>
                            <div className="space-y-1">
                                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Response</h3>
                                <p className="whitespace-pre-wrap break-words text-sm">{selected?.response || '—'}</p>
                            </div>
                        </div>
                    </ScrollArea>
                </DialogContent>
            </Dialog>
        </SettingsPage>
    );
}
