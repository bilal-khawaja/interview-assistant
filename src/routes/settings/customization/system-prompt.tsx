import { createFileRoute } from '@tanstack/react-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SettingsPage, SettingsSection } from '@/components/settings-page';

export const Route = createFileRoute('/settings/customization/system-prompt')({
    component: SystemPromptSettings,
});

function SystemPromptSettings() {
    return (
        <SettingsPage title="System Prompt" description="Instructions sent to the model before every conversation.">
            <Alert>
                <AlertDescription>Not functional yet. Nothing entered here is saved or sent.</AlertDescription>
            </Alert>
            <SettingsSection>
                <div className="space-y-2">
                    <Label htmlFor="system-prompt">Prompt</Label>
                    <Textarea id="system-prompt" rows={8} placeholder="You are a helpful assistant." disabled />
                    <div className="flex justify-end gap-2">
                        <Button variant="outline" disabled>
                            Reset to default
                        </Button>
                        <Button disabled>Save</Button>
                    </div>
                </div>
            </SettingsSection>
        </SettingsPage>
    );
}
