import { useCallback, useEffect, useState } from 'react';
import { IconCheck, IconCopy, IconTrash } from '@tabler/icons-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { copyToClipboard } from '@/lib/clipboard-client';
import { meetingAccess } from '@/lib/meeting-access-client';
import type { ApiResult, CreatedInvite, Meeting, MeetingInvite, MeetingMember } from '@/types/transcript';

const EXPIRIES = [
    { value: '60', label: '1 hour' },
    { value: '1440', label: '24 hours' },
    { value: '10080', label: '7 days' },
] as const;

function when(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? ''
        : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function uses(invite: MeetingInvite): string {
    return invite.maxUses === null ? `${invite.useCount} joined` : `${invite.useCount} of ${invite.maxUses} used`;
}

/**
 * Who is in a meeting, for everyone in it. The host also hands out links and takes people out;
 * a participant only sees the list.
 */
export function MembersDialog({
    open,
    onOpenChange,
    meeting,
    canManage,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    meeting: Meeting;
    canManage: boolean;
}) {
    const [invites, setInvites] = useState<MeetingInvite[]>([]);
    const [members, setMembers] = useState<MeetingMember[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [expiry, setExpiry] = useState<string>('1440');
    const [maxUses, setMaxUses] = useState('');
    const [creating, setCreating] = useState(false);
    const [created, setCreated] = useState<CreatedInvite | null>(null);
    const [copied, setCopied] = useState(false);

    const reload = useCallback(async () => {
        setLoading(true);
        const [inv, mem] = await Promise.all([
            canManage ? meetingAccess.listInvites(meeting.id) : Promise.resolve<ApiResult<{ invites: MeetingInvite[] }>>({ invites: [] }),
            meetingAccess.listMembers(meeting.id),
        ]);
        setLoading(false);
        if (inv.error !== undefined) setError(inv.error);
        else setInvites(inv.invites);
        if (mem.error !== undefined) setError(mem.error);
        else setMembers(mem.members);
    }, [meeting.id, canManage]);

    useEffect(() => {
        if (!open) return;
        setError(null);
        setCreated(null);
        setCopied(false);
        void reload();
        // New people join while the dialog is open, so keep the list fresh.
        const timer = setInterval(() => void reload(), 5_000);
        return () => clearInterval(timer);
    }, [open, reload]);

    const create = async () => {
        const limit = maxUses.trim() === '' ? null : Number(maxUses);
        if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
            setError('Maximum people must be a whole number from 1 to 100, or empty for no limit.');
            return;
        }
        setCreating(true);
        setError(null);
        const result = await meetingAccess.createInvite(meeting.id, { expiresInMinutes: Number(expiry), maxUses: limit });
        setCreating(false);
        if (result.error !== undefined) {
            setError(result.status === 409 ? 'This meeting has ended, so it cannot take new people.' : result.error);
            return;
        }
        setCreated(result.invite);
        setCopied(false);
        void reload();
    };

    const copy = async () => {
        if (!created) return;
        if (await copyToClipboard(created.url)) {
            setCopied(true);
            setError(null);
        } else {
            setError('Could not copy. Select the link and copy it yourself.');
        }
    };

    const revoke = async (invite: MeetingInvite) => {
        const result = await meetingAccess.revokeInvite(meeting.id, invite.id);
        if (result.error !== undefined && result.status !== 404) setError(result.error);
        if (created?.id === invite.id) setCreated(null);
        void reload();
    };

    const remove = async (member: MeetingMember) => {
        const result = await meetingAccess.removeMember(meeting.id, member.userId);
        if (result.error !== undefined && result.status !== 404) setError(result.error);
        void reload();
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{canManage ? 'Invite people' : 'People in this meeting'}</DialogTitle>
                    <DialogDescription>
                        {canManage
                            ? 'Anyone with an account who opens a link you make can join this meeting and speak in it. Send the link yourself; it works until it expires, runs out, or you revoke it.'
                            : 'Everyone who is in this meeting right now. The host can add or remove people.'}
                    </DialogDescription>
                </DialogHeader>

                {error && (
                    <Alert variant="destructive">
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                )}

                {canManage && meeting.status !== 'ended' && (
                    <div className="space-y-3 rounded-lg border p-3">
                        <div className="flex flex-wrap items-end gap-3">
                            <div className="space-y-1.5">
                                <Label htmlFor="invite-expiry">Link works for</Label>
                                <Select value={expiry} onValueChange={setExpiry}>
                                    <SelectTrigger id="invite-expiry" className="w-36">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {EXPIRIES.map((e) => (
                                            <SelectItem key={e.value} value={e.value}>
                                                {e.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="invite-uses">Most people</Label>
                                <Input
                                    id="invite-uses"
                                    inputMode="numeric"
                                    className="w-28"
                                    placeholder="No limit"
                                    value={maxUses}
                                    onChange={(e) => setMaxUses(e.target.value.replace(/\D/g, ''))}
                                />
                            </div>
                            <Button disabled={creating} onClick={() => void create()}>
                                {creating && <Spinner className="mr-2 size-4" />}
                                Generate link
                            </Button>
                        </div>

                        {created && (
                            <div className="space-y-1.5">
                                <Label htmlFor="invite-link">New link</Label>
                                <div className="flex gap-2">
                                    <Input id="invite-link" readOnly value={created.url} onFocus={(e) => e.target.select()} />
                                    <Button variant="outline" size="icon" aria-label="Copy link" onClick={() => void copy()}>
                                        {copied ? <IconCheck className="size-4" /> : <IconCopy className="size-4" />}
                                    </Button>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    This is the only time the link is shown. Expires {when(created.expiresAt)}.
                                </p>
                            </div>
                        )}
                    </div>
                )}

                {canManage && (
                <section className="space-y-1.5">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Active links</h3>
                    {invites.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{loading ? 'Loading…' : 'No active links.'}</p>
                    ) : (
                        <ul className="space-y-1">
                            {invites.map((invite) => (
                                <li key={invite.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50">
                                    <span className="min-w-0 flex-1">
                                        Made {when(invite.createdAt)}
                                        <span className="block text-xs text-muted-foreground">
                                            Expires {when(invite.expiresAt)} · {uses(invite)}
                                        </span>
                                    </span>
                                    <Button variant="ghost" size="sm" onClick={() => void revoke(invite)}>
                                        Revoke
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
                )}

                <section className="space-y-1.5">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {canManage ? 'People in this meeting' : 'Members'}
                    </h3>
                    {members.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{loading ? 'Loading…' : 'Nobody is here yet.'}</p>
                    ) : (
                        <ul className="space-y-1">
                            {members.map((member) => (
                                <li key={member.userId} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50">
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate font-medium">
                                            {member.name}
                                            {member.role === 'owner' && (
                                                <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                                                    Host
                                                </span>
                                            )}
                                        </span>
                                        {member.email && (
                                            <span className="block truncate text-xs text-muted-foreground">{member.email}</span>
                                        )}
                                    </span>
                                    {canManage && member.role === 'participant' && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="size-7"
                                            aria-label={`Remove ${member.name}`}
                                            onClick={() => void remove(member)}
                                        >
                                            <IconTrash className="size-4" />
                                        </Button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </DialogContent>
        </Dialog>
    );
}
