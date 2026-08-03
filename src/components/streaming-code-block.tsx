import { isValidElement, useEffect, useState } from 'react';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { ensureLanguageLoaded, getHighlighter } from '@/lib/shiki';
import { cn } from '@/lib/utils';

function getText(node: React.ReactNode): string {
    if (typeof node === 'string') return node;
    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(getText).join('');
    if (isValidElement<{ children?: React.ReactNode }>(node)) {
        return getText(node.props.children);
    }
    return '';
}

function getCodeInfo(children: React.ReactNode) {
    if (!isValidElement<{ className?: string; children?: React.ReactNode }>(children)) {
        return { code: getText(children), lang: 'text' };
    }
    const lang = /language-(\w+)/.exec(children.props.className ?? '')?.[1] ?? 'text';
    return { code: getText(children.props.children), lang };
}

export function StreamingCodeBlock({
    children,
    skipHighlight,
}: React.ComponentProps<'pre'> & { skipHighlight?: boolean }) {
    const { code, lang } = getCodeInfo(children);
    const [html, setHtml] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (skipHighlight) {
            setHtml(null);
            return;
        }
        let cancelled = false;
        getHighlighter().then(async (highlighter) => {
            const loadedLang = await ensureLanguageLoaded(highlighter, lang);
            if (cancelled) return;
            setHtml(
                highlighter.codeToHtml(code, {
                    lang: loadedLang,
                    theme: 'github-light',
                }),
            );
        });
        return () => {
            cancelled = true;
        };
    }, [code, lang, skipHighlight]);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    return (
        <div className="group relative">
            <button
                type="button"
                onClick={handleCopy}
                aria-label="Copy code"
                className={cn(
                    'absolute top-2 right-2 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity',
                    'hover:bg-accent hover:text-accent-foreground group-hover:opacity-100',
                    copied && 'opacity-100',
                )}
            >
                {copied ? <IconCheck className="size-3.5" /> : <IconCopy className="size-3.5" />}
            </button>
            {html ? (
                <div dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
                <pre>
                    <code>{code}</code>
                </pre>
            )}
        </div>
    );
}
