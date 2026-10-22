import {
    IconAdjustments,
    IconArrowLeft,
    IconBrain,
    IconBrush,
    IconMessage,
    IconMessageCode,
    IconMicrophone,
    IconPlug,
    IconScissors,
    IconVectorTriangle,
} from '@tabler/icons-react';
import type { ComponentType } from 'react';

export type SettingsNavItem = {
    label: string;
    to: string;
    icon: ComponentType<{ className?: string }>;
};

export type SettingsNavGroup = {
    label: string;
    icon?: ComponentType<{ className?: string }>;
    /** Renders as a drop-down menu item instead of a labelled group. */
    collapsible?: boolean;
    items: SettingsNavItem[];
};

export const SETTINGS_BACK = { label: 'Back', to: '/ai', icon: IconArrowLeft } satisfies SettingsNavItem;

export const SETTINGS_NAV: SettingsNavGroup[] = [
    {
        label: 'AI Providers',
        icon: IconPlug,
        collapsible: true,
        items: [
            { label: 'LLM', to: '/settings/ai/llm', icon: IconBrain },
            { label: 'Embedding Model', to: '/settings/ai/embedder', icon: IconVectorTriangle },
            { label: 'Text Splitter & Chunking', to: '/settings/ai/chunking', icon: IconScissors },
            { label: 'Transcription Model', to: '/settings/ai/transcription', icon: IconMicrophone },
        ],
    },
    {
        label: 'Customization',
        icon: IconBrush,
        collapsible: true,
        items: [
            { label: 'UI Preferences', to: '/settings/customization/ui', icon: IconAdjustments },
            { label: 'Chat', to: '/settings/customization/chat', icon: IconMessage },
            { label: 'System Prompt', to: '/settings/customization/system-prompt', icon: IconMessageCode },
        ],
    },
];
