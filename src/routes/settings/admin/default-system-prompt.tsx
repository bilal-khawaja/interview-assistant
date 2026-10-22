import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { SettingField, SettingsPage, SettingsSection } from '@/components/settings-page';
import { FALLBACK_SYSTEM_PROMPT, useDefaultSystemPrompt } from '@/lib/use-default-system-prompt';

export const Route = createFileRoute('/settings/admin/default-system-prompt')({
    component: DefaultSystemPrompt,
});

function DefaultSystemPrompt() {
    const { saved, save, reset } = useDefaultSystemPrompt();
    const [draft, setDraft] = useState(saved);
    const dirty = draft !== saved;

    return (
        <SettingsPage
            title="Default System Prompt"
            description="The global prompt for every conversation. Separate from the System Prompt under Customization."
        >
            <Alert>
                <AlertDescription>
                    Saved on this device, but not yet applied to chats.
                </AlertDescription>
            </Alert>
            <SettingsSection>
                <SettingField label="Prompt" htmlFor="default-system-prompt">
                    <Textarea
                        id="default-system-prompt"
                        rows={10}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                    />
                </SettingField>
                <div className="flex justify-end gap-2">
                    <Button
                        variant="outline"
                        onClick={() => {
                            reset();
                            setDraft(FALLBACK_SYSTEM_PROMPT);
                        }}
                    >
                        Reset to default
                    </Button>
                    <Button disabled={!dirty} onClick={() => save(draft)}>
                        Save changes
                    </Button>
                </div>
            </SettingsSection>
        </SettingsPage>
    );
}
