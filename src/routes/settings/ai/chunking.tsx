import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { NotWiredNotice, SaveBar } from '@/components/provider-notice';
import { SettingField, SettingsPage, SettingsSection } from '@/components/settings-page';
import { Input } from '@/components/ui/input';

export const Route = createFileRoute('/settings/ai/chunking')({
    component: ChunkingSettings,
});

function ChunkingSettings() {
    const [chunkSize, setChunkSize] = useState('1000');
    const [overlap, setOverlap] = useState('20');

    return (
        <SettingsPage title="Text Splitter & Chunking" description="How documents are split before they are embedded.">
            <NotWiredNotice />
            <SettingsSection
                title="Text Splitter Preferences"
                description="Only change these if you understand how splitting affects retrieval."
            >
                <SettingField
                    label="Text Chunk Size"
                    htmlFor="chunk-size"
                    description="Maximum number of characters in a single chunk."
                >
                    <Input
                        id="chunk-size"
                        type="number"
                        min={1}
                        value={chunkSize}
                        onChange={(e) => setChunkSize(e.target.value)}
                    />
                </SettingField>
                <SettingField
                    label="Text Chunk Overlap"
                    htmlFor="chunk-overlap"
                    description="Characters shared between neighboring chunks."
                >
                    <Input
                        id="chunk-overlap"
                        type="number"
                        min={0}
                        value={overlap}
                        onChange={(e) => setOverlap(e.target.value)}
                    />
                </SettingField>
            </SettingsSection>
            <SaveBar />
        </SettingsPage>
    );
}
