import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { NotWiredNotice, SaveBar } from '@/components/provider-notice';
import { SecretInput } from '@/components/secret-input';
import { SettingField, SettingsPage, SettingsSection } from '@/components/settings-page';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MODELS } from '@/lib/models';

export const Route = createFileRoute('/settings/ai/llm')({
    component: LlmSettings,
});

const PROVIDERS = [
    { value: 'openai', label: 'OpenAI', keyLabel: 'OpenAI API Key', placeholder: 'sk-...' },
    { value: 'anthropic', label: 'Anthropic', keyLabel: 'Anthropic API Key', placeholder: 'sk-ant-...' },
    { value: 'gemini', label: 'Google Gemini', keyLabel: 'Google AI API Key', placeholder: 'AIza...' },
] as const;

function LlmSettings() {
    const [provider, setProvider] = useState<(typeof PROVIDERS)[number]['value']>('openai');
    const [apiKey, setApiKey] = useState('');
    const [model, setModel] = useState<string>(MODELS[0].value);
    const active = PROVIDERS.find((p) => p.value === provider) ?? PROVIDERS[0];
    const selectedModel = MODELS.find((m) => m.value === model);

    return (
        <SettingsPage title="LLM" description="The chat model and provider credentials used for conversations.">
            <NotWiredNotice />
            <SettingsSection title="LLM Provider" description="Pick who serves your chat model.">
                <SettingField label="Provider" htmlFor="llm-provider">
                    <Select value={provider} onValueChange={(v) => setProvider(v as typeof provider)}>
                        <SelectTrigger id="llm-provider">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {PROVIDERS.map((p) => (
                                <SelectItem key={p.value} value={p.value}>
                                    {p.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </SettingField>
                <SettingField label={active.keyLabel} htmlFor="llm-key" description="Hidden by default. Toggle to reveal.">
                    <SecretInput
                        id="llm-key"
                        placeholder={active.placeholder}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                    />
                </SettingField>
                <SettingField label="Chat Model Selection" htmlFor="llm-model">
                    <Select value={model} onValueChange={setModel} disabled={provider !== 'openai'}>
                        <SelectTrigger id="llm-model">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {MODELS.map((m) => (
                                <SelectItem key={m.value} value={m.value}>
                                    {m.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    {provider === 'openai' && selectedModel && (
                        <div className="flex gap-2">
                            {selectedModel.webSearch && <Badge variant="secondary">Web search</Badge>}
                            {selectedModel.reasoning && <Badge variant="secondary">Reasoning</Badge>}
                        </div>
                    )}
                </SettingField>
            </SettingsSection>
            <SaveBar />
        </SettingsPage>
    );
}
