import { useState } from 'react';

const STORAGE_KEY = 'admin.defaultSystemPrompt';

export const FALLBACK_SYSTEM_PROMPT = 'You are a helpful assistant.';

export function readDefaultSystemPrompt(): string {
    return localStorage.getItem(STORAGE_KEY) ?? FALLBACK_SYSTEM_PROMPT;
}

/** Global default prompt, separate from the per-user System Prompt under Customization. */
export function useDefaultSystemPrompt() {
    const [saved, setSaved] = useState(readDefaultSystemPrompt);

    const save = (value: string) => {
        localStorage.setItem(STORAGE_KEY, value);
        setSaved(value);
    };

    const reset = () => {
        localStorage.removeItem(STORAGE_KEY);
        setSaved(FALLBACK_SYSTEM_PROMPT);
    };

    return { saved, save, reset };
}
