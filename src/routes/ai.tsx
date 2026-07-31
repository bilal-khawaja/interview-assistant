import { useRef, useState } from 'react';
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
        <SidebarProvider>
            <AppSidebar />
            <SidebarInset className="min-w-0">
            <div className="flex flex-col items-center justify-center min-h-screen bg-background p-4 sm:p-6">
                <div className="w-full max-w-2xl flex flex-col items-center justify-center space-y-6 ml-auto mb-auto">
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
                    <h1 className="pointer-events-none cursor-default select-none text-3xl font-semibold tracking-tight text-slate-950 text-center mb-2 [text-shadow:_0_0_10px_rgba(0,0,0,0.15)]">                        The floor is yours
                    </h1>
                </div>
            )}
            <div className="relative mt-6 flex justify-center w-full">
                {modelMenuOpen && (
                    <div  className="absolute no-scrollbar bottom-full right-4 sm:right-6 mb-2 w-36 max-h-48 overflow-y-auto rounded-xl border bg-popover p-1 shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-150 z-20">                        {MODELS.map((m) => (
                            <button
                                key={m.value}
                                type="button"
                                onClick={() => {
                                    setModel(m.value);
                                    setModelMenuOpen(false);
                                }}
                                className={` relative w-full rounded-md px-2 py-1 text-left text-xs hover:bg-accent transition-colors ${
                                    m.value === model ? 'font-semibold text-foreground' : 'text-muted-foreground'
                                }`}
                            >
                                {m.label}
                            </button>
                        ))}
                    </div>

                )}
                <div className="relative w-full max-w-[90%] sm:max-w-md md:max-w-lg lg:max-w-2xl min-w-[260px] mx-auto">
                    <div className="flex items-center gap-1.5 rounded-full border border-border/60 bg-[#f9faf9] px-3 py-1 shadow-sm transition-shadow hover:shadow-md focus-within:ring-1 focus-within:ring-ring">
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
                            className="no-scrollbar flex-1 resize-none bg-transparent px-2 py-1.5 text-xs sm:text-sm leading-normal text-black outline-none placeholder:text-muted-foreground min-h-[2rem] max-h-36 sm:max-h-48 overflow-y-auto self-center"
                        />
                        <div className="flex shrink-0 items-center gap-1.5">
                            <button
                                type="button"
                                onClick={() => setModelMenuOpen((o) => !o)}
                                className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[11px] sm:text-xs font-medium transition-colors hover:bg-accent"
                            >
                                {modelLabel}
                                <IconChevronUp className={`size-3 transition-transform ${modelMenuOpen ? 'rotate-180' : ''}`} />
                            </button>
                            <button
                                type="button"
                                onClick={handleSend}
                                disabled={loading || !prompt}
                                aria-label="Send"
                                className="flex size-6 sm:size-7 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-50"
                            >
                                <IconSend className="size-3.5" />
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
