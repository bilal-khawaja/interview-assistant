import { createFileRoute } from '@tanstack/react-router';
import { SettingRow, SettingsPage, SettingsSection } from '@/components/settings-page';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useThemeSetting, type Theme } from '@/lib/use-theme-setting';
import { useStreamSetting } from '@/lib/use-stream-setting';
import { useOpacitySetting } from '@/lib/use-opacity-setting';
import { useClickThroughSetting } from '@/lib/use-click-through-setting';

export const Route = createFileRoute('/settings/customization/ui')({
    component: UiPreferences,
});

function UiPreferences() {
    const [theme, setTheme] = useThemeSetting();
    const [stream, setStream] = useStreamSetting();
    const [opacity, setOpacity] = useOpacitySetting();
    const [clickThrough, setClickThrough] = useClickThroughSetting();

    return (
        <SettingsPage title="UI Preferences" description="Control how the window looks and responds.">
            <SettingsSection>
                <SettingRow label="Theme" description="Switch between light and dark mode." htmlFor="theme">
                    <Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
                        <SelectTrigger id="theme" className="w-32">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="light">Light</SelectItem>
                            <SelectItem value="dark">Dark</SelectItem>
                        </SelectContent>
                    </Select>
                </SettingRow>
                <SettingRow label="Streaming response" description="Show replies as they are generated." htmlFor="stream">
                    <Switch id="stream" checked={stream} onCheckedChange={setStream} />
                </SettingRow>
                <SettingRow label="Window opacity" description="Make the window see-through." htmlFor="opacity">
                    <span className="w-10 text-right text-xs text-muted-foreground">{Math.round(opacity * 100)}%</span>
                    <Slider
                        id="opacity"
                        className="w-32"
                        min={0.2}
                        max={1}
                        step={0.05}
                        value={[opacity]}
                        onValueChange={([v]) => setOpacity(v)}
                    />
                </SettingRow>
                <SettingRow
                    label="Click-through"
                    description={clickThrough ? 'Press Ctrl+Shift+X to regain control.' : 'Let clicks pass through the window.'}
                    htmlFor="click-through"
                >
                    <Switch id="click-through" checked={clickThrough} onCheckedChange={setClickThrough} />
                </SettingRow>
            </SettingsSection>
        </SettingsPage>
    );
}
