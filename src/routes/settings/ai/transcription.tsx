import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { NotWiredNotice, SaveBar } from '@/components/provider-notice';
import { SecretInput } from '@/components/secret-input';
import { SettingField, SettingsPage, SettingsSection } from '@/components/settings-page';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export const Route = createFileRoute('/settings/ai/transcription')({
    component: TranscriptionSettings,
});

function TranscriptionSettings() {
    const [provider, setProvider] = useState('openai');
    const [apiKey, setApiKey] = useState('');

    return (
        <SettingsPage title="Transcription Model" description="Speech-to-text used for audio and realtime input.">
            <NotWiredNotice />
            <SettingsSection title="Transcription Provider" description="Pick the service that turns audio into text.">
                <SettingField label="Provider" htmlFor="stt-provider">
                    <Select value={provider} onValueChange={setProvider}>
                        <SelectTrigger id="stt-provider">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="openai">OpenAI Whisper</SelectItem>
                            <SelectItem value="local">Built-in (local Whisper)</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingField>
                {provider === 'openai' && (
                    <SettingField label="OpenAI API Key" htmlFor="stt-key">
                        <SecretInput
                            id="stt-key"
                            placeholder="sk-..."
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                        />
                    </SettingField>
                )}
                <SettingField label="Model" htmlFor="stt-model">
                    <Select value="whisper-1" disabled>
                        <SelectTrigger id="stt-model">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="whisper-1">whisper-1</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingField>
            </SettingsSection>
            <SaveBar />
        </SettingsPage>
    );
}
