import { createFileRoute } from '@tanstack/react-router';
import { SettingRow, SettingsPage, SettingsSection } from '@/components/settings-page';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { authStore, useAuth } from '@/lib/auth-client';
import { useMeetings } from '@/lib/transcript-client';

export const Route = createFileRoute('/settings/account')({
    component: AccountSettings,
});

function AccountSettings() {
    const { auth, busy } = useAuth();
    const meetings = useMeetings();
    const user = auth.status === 'signedIn' ? auth.user : null;

    return (
        <SettingsPage title="Profile" description="The account your meetings and meeting chats belong to.">
            <SettingsSection>
                <SettingRow label="Name">
                    <span className="text-sm">{user?.name ?? '-'}</span>
                </SettingRow>
                <SettingRow label="Email">
                    <span className="text-sm">{user?.email ?? '-'}</span>
                </SettingRow>
                <SettingRow label="Backend" description="Set under Customization, Meetings Backend.">
                    <span className="text-sm text-muted-foreground">{meetings.backendUrl}</span>
                </SettingRow>
            </SettingsSection>
            <SettingsSection
                title="Sign out"
                description={
                    meetings.runningHere
                        ? 'The meeting you are running will be ended first.'
                        : 'Your meetings and chats stay on your account. Chats on this device are kept for when you sign in again.'
                }
            >
                <div className="flex justify-end">
                    <Button variant="outline" disabled={busy || !user} onClick={() => void authStore.signOut()}>
                        {busy && <Spinner className="mr-2 size-4" />}
                        Sign out
                    </Button>
                </div>
            </SettingsSection>
        </SettingsPage>
    );
}
