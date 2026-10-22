import { createFileRoute } from '@tanstack/react-router';
import { SettingRow, SettingsPage, SettingsSection } from '@/components/settings-page';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useWebSearchSetting } from '@/lib/use-web-search-setting';
import { useReasoningSetting } from '@/lib/use-reasoning-setting';

export const Route = createFileRoute('/settings/customization/chat')({
    component: ChatPreferences,
});

function ChatPreferences() {
    const [webSearch, setWebSearch] = useWebSearchSetting();
    const [reasoning, setReasoning] = useReasoningSetting();

    return (
        <SettingsPage title="Chat" description="Default behavior for new messages.">
            <SettingsSection>
                <SettingRow label="Web search" description="Let supported models search the web." htmlFor="web-search">
                    <Switch id="web-search" checked={webSearch} onCheckedChange={setWebSearch} />
                </SettingRow>
                <SettingRow label="Reasoning" description="Show the model's thinking on supported models." htmlFor="reasoning">
                    <Switch id="reasoning" checked={reasoning} onCheckedChange={setReasoning} />
                </SettingRow>
                <SettingRow label="Reasoning effort" description="Coming soon. Set from the chat toolbar for now.">
                    <Select disabled defaultValue="medium">
                        <SelectTrigger className="w-32">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {['minimal', 'low', 'medium', 'high'].map((effort) => (
                                <SelectItem key={effort} value={effort} className="capitalize">
                                    {effort}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </SettingRow>
            </SettingsSection>
        </SettingsPage>
    );
}
