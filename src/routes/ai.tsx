import { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { tipcClient, rendererHandlers } from '@/lib/tipc-client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from '@/layout/sidebar';
import { useStreamSetting } from '@/lib/use-stream-setting';
import { IconChevronUp, IconSend } from '@tabler/icons-react';

export const Route = createFileRoute('/ai')({
    component: AiChat,
});

const MODELS = [
    { label: 'GPT-5.2', value: 'gpt-5.2' },
    { label: 'GPT-5.2 Pro', value: 'gpt-5.2-pro' },
    { label: 'GPT-5.1', value: 'gpt-5.1' },
    { label: 'GPT-5', value: 'gpt-5' },
    { label: 'GPT-5 Mini', value: 'gpt-5-mini' },
    { label: 'GPT-4.1', value: 'gpt-4.1' },
    { label: 'GPT-4.1 Mini', value: 'gpt-4.1-mini' },
    { label: 'GPT-4o', value: 'gpt-4o' },
    { label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
] as const;

function AiChat() {
    const [model, setModel] = useState<string>(MODELS[0].value);
    const [prompt, setPrompt] = useState('');
    const [stream] = useStreamSetting();
    const [output, setOutput] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [modelMenuOpen, setModelMenuOpen] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const chatMutation = tipcClient.ai.chat.useMutation();
    const modelLabel = MODELS.find((m) => m.value === model)?.label ?? model;

    const growTextarea = (el: HTMLTextAreaElement) => {
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    };

    const handleSend = async () => {
        if (!prompt) return;
        setLoading(true);
        setError(null);
        setOutput('');

        const id = crypto.randomUUID();

        if (stream) {
            const offChunk = rendererHandlers.onAiChunk.listen((data) => {
                if (data.id !== id) return;
                setOutput((prev) => prev + data.delta);
            });
            const offDone = rendererHandlers.onAiDone.listen((data) => {
                if (data.id !== id) return;
                setLoading(false);
                cleanup();
            });
            const offError = rendererHandlers.onAiError.listen((data) => {
                if (data.id !== id) return;
                setError(data.message);
                setLoading(false);
                cleanup();
            });
            const cleanup = () => {
                offChunk();
                offDone();
                offError();
            };

            await chatMutation.mutateAsync({ id, model, prompt, stream: true });
            return;
        }

        const result = await chatMutation.mutateAsync({ id, model, prompt, stream: false });
        setLoading(false);
        if (result?.error) {
            setError(result.error);
        } else {
            setOutput(result?.text ?? '');
        }
    };

    return (
        <SidebarProvider style={{ '--sidebar-width': '20rem' } as CSSProperties}>
            <AppSidebar />
            <SidebarInset>
            <div className="min-h-screen bg-background p-4">

            <div className="mx-auto w-full max-w-2xl space-y-10 py-16">

                {error && (
                    <Alert variant="destructive">
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                )}

                <div className="min-h-40 whitespace-pre-wrap text-base leading-relaxed">
                    {output}
                </div>

{!output && !loading && (
    <div className="flex justify-center mb-6">
        <h1 className="absolute bottom-90 pointer-events-none cursor-default select-none text-3xl font-semibold tracking-tight text-slate-950 [text-shadow:_0_0_10px_rgba(0,0,0,0.3),_0_0_20px_rgba(0,0,0,0.2),_0_0_40px_rgba(0,0,0,0.15)]">
            The floor is yours
        </h1>
    </div>
)}

                <div className="relative">
                    {modelMenuOpen && (
                        <div className="absolute bottom-full right-0 mb-2 w-32 origin-bottom-right animate-in fade-in slide-in-from-bottom-2 rounded-xl border bg-popover p-1 shadow-lg duration-150">
                            {MODELS.map((m) => (
                                <button
                                    key={m.value}
                                    type="button"
                                    onClick={() => {
                                        setModel(m.value);
                                        setModelMenuOpen(false);
                                    }}
                                    className={`w-full rounded-md px-2 py-1 text-left text-xs hover:bg-accent ${
                                        m.value === model ? 'font-semibold text-foreground' : 'text-muted-foreground'
                                    }`}
                                >
                                    {m.label}
                                </button>
                            ))}
                        </div>
                    )}
                    <div className="relative mx-auto w-full max-w-xl">
                    <div className="flex items-center gap-2 rounded-full border border-border/60 bg-[#f9faf9] p-1.5 shadow-md transition-shadow hover:shadow-lg">
                        <textarea
                            ref={textareaRef}
                            id="prompt"
                            placeholder="Ask something..."
                            rows={1}
                            value={prompt}
                            onChange={(e) => {
                                setPrompt(e.target.value);
                                growTextarea(e.target);
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    if (!loading && prompt) handleSend();
                                }
                            }}
className="no-scrollbar max-h-60 min-h-[2.25rem] flex-1 resize-none self-center overflow-y-auto bg-transparent px-2 py-2.5 text-sm leading-normal text-black outline-none placeholder:text-muted-foreground"                        />

                        <div className="flex shrink-0 items-center gap-1.5 mr-3">
                            <button
                                type="button"
                                onClick={() => setModelMenuOpen((o) => !o)}
                                className="flex items-center gap-1 rounded-full bg-muted px-3 py-1.5 text-xs font-medium hover:bg-accent"
                            >
                                {modelLabel}
                                <IconChevronUp className={`size-3.5 transition-transform ${modelMenuOpen ? 'rotate-180' : ''}`} />
                            </button>

                            <button
                                type="button"
                                onClick={handleSend}
                                disabled={loading || !prompt}
                                aria-label="Send"
                                className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-50"
                            >
                                <IconSend className="size-4" />
                            </button>
                        </div>
                    </div>
                    </div>
                </div>

            </div>
            </div>
            </SidebarInset>
        </SidebarProvider>
    );
}
