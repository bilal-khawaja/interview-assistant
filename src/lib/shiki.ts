import type { Highlighter } from 'shiki';

let highlighterPromise: Promise<Highlighter> | undefined;

export function getHighlighter() {
    highlighterPromise ??= import('shiki').then((shiki) =>
        shiki.createHighlighter({
            themes: ['github-light'],
            langs: [],
        }),
    );
    return highlighterPromise;
}

export async function ensureLanguageLoaded(highlighter: Highlighter, lang: string) {
    if (highlighter.getLoadedLanguages().includes(lang)) return lang;
    const { bundledLanguages } = await import('shiki');
    if (!(lang in bundledLanguages)) return 'text';
    try {
        await highlighter.loadLanguage(lang as keyof typeof bundledLanguages);
        return lang;
    } catch {
        return 'text';
    }
}
