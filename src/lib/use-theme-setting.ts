import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'ui.theme';

function readStoredTheme(): Theme {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
}

// Applied on import so the first paint already uses the stored theme.
applyTheme(readStoredTheme());

export function useThemeSetting() {
    const [theme, setTheme] = useState<Theme>(readStoredTheme);

    useEffect(() => {
        localStorage.setItem(STORAGE_KEY, theme);
        applyTheme(theme);
    }, [theme]);

    return [theme, setTheme] as const;
}
