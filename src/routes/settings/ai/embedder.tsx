import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { NotWiredNotice, SaveBar } from '@/components/provider-notice';
import { SecretInput } from '@/components/secret-input';
import { SettingField, SettingsPage, SettingsSection } from '@/components/settings-page';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export const Route = createFileRoute('/settings/ai/embedder')({
    component: EmbedderSettings,
});

const EMBEDDING_MODELS = ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'] as const;

function EmbedderSettings() {
    const [model, setModel] = useState<string>(EMBEDDING_MODELS[0]);
    const [apiKey, setApiKey] = useState('');

    return (
        <SettingsPage title="Embedding Model" description="Turns documents and queries into vectors for retrieval.">
            <NotWiredNotice />
            <SettingsSection
                title="Embedding Preference"
                description="Changing the model requires re-embedding existing documents."
            >
                <SettingField label="Embedding Provider" htmlFor="embed-provider">
                    <Select value="openai" disabled>
                        <SelectTrigger id="embed-provider">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="openai">OpenAI</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingField>
                <SettingField label="OpenAI API Key" htmlFor="embed-key">
                    <SecretInput
                        id="embed-key"
                        placeholder="sk-..."
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                    />
                </SettingField>
                <SettingField label="Model Preference" htmlFor="embed-model">
                    <Select value={model} onValueChange={setModel}>
                        <SelectTrigger id="embed-model">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {EMBEDDING_MODELS.map((m) => (
                                <SelectItem key={m} value={m}>
                                    {m}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </SettingField>
            </SettingsSection>
            <SaveBar />
        </SettingsPage>
    );
}
