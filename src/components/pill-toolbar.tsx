import { useEffect, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { GripVertical, X } from 'lucide-react';
import { tipcInvoker } from '@/lib/tipc-client';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';

const PILL_MODEL = 'gpt-4.1-nano';
const HEIGHT_COMPACT = 56;
const HEIGHT_EXPANDED = 320;

export function PillToolbar() {
    const [prompt, setPrompt] = useState('');
    const [reply, setReply] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        // index.css sets a solid body background — this window is transparent
        // at the OS level, so the default background must be cleared here or
        // it paints square white corners behind our rounded pill shape.
        document.documentElement.style.background = 'transparent';
        document.body.style.background = 'transparent';
    }, []);

    const hide = () => {
        tipcInvoker.window.hidePill();
    };

    const resize = (expanded: boolean) => {
        tipcInvoker.window.resizePill({ height: expanded ? HEIGHT_EXPANDED : HEIGHT_COMPACT });
    };

    const handleSubmit = async () => {
        const trimmed = prompt.trim();
        if (!trimmed || isLoading) return;

        setIsLoading(true);
        setError(null);
        setReply('');
        resize(true);

        const result = await tipcInvoker.ai.chat({
            id: crypto.randomUUID(),
            model: PILL_MODEL,
            prompt: trimmed,
            stream: false,
        });

        setIsLoading(false);
        if (result?.error) {
            setError(result.error);
        } else {
            setReply(result?.text ?? '');
        }
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleSubmit();
        } else if (e.key === 'Escape') {
            hide();
        }
    };

    return (
        <div
            className="flex h-screen w-screen flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#1c1c1e]/95 text-white shadow-2xl"
            onKeyDown={(e) => {
                if (e.key === 'Escape') hide();
            }}
        >
            <div
                className="flex shrink-0 items-center gap-2 px-5 py-3"
                style={{ WebkitAppRegion: 'drag' } as CSSProperties}
            >
                <GripVertical className="h-4 w-4 shrink-0 text-white/40" />
                <input
                    autoFocus
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask anything..."
                    className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-white/40 outline-none"
                    style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                />
                {isLoading && <Spinner className="h-4 w-4 shrink-0 text-white/60" />}
                <button
                    type="button"
                    aria-label="Hide"
                    onClick={hide}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white/50 hover:bg-white/10 hover:text-white"
                    style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>




            {(reply || error) && (
                <ScrollArea className="min-h-0 flex-1 border-t border-white/10 px-3 py-2">
                    {error ? (
                        <p className="text-sm text-red-400">{error}</p>
                    ) : (
                        <div className="text-sm leading-normal text-white/90">
                            <MarkdownRenderer content={reply} isStreaming={false} />
                        </div>
                    )}
                </ScrollArea>
            )}
        </div>
    );
}
