import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { tipcClient, rendererHandlers } from '@/lib/tipc-client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from '@/layout/sidebar';
import { useStreamSetting } from '@/lib/use-stream-setting';
import { useWebSearchSetting } from '@/lib/use-web-search-setting';
import { useReasoningSetting } from '@/lib/use-reasoning-setting';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { PromptInputBox } from '@/components/ui/ai-prompt-box';
import type { ReasoningEffort } from '@/ai/ports/chat.port';

export const Route = createFileRoute('/ai')({
    component: AiChat,
});

const REASONING_EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

const MODELS = [
    { label: 'GPT-4.1 Nano', value: 'gpt-4.1-nano', webSearch: false, reasoning: false },
    { label: 'GPT-5.2', value: 'gpt-5.2', webSearch: true, reasoning: true },
    { label: 'GPT-5.2 Pro', value: 'gpt-5.2-pro', webSearch: true, reasoning: true },
    { label: 'GPT-5.1', value: 'gpt-5.1', webSearch: true, reasoning: true },
    { label: 'GPT-5', value: 'gpt-5', webSearch: true, reasoning: true },
    { label: 'GPT-5 Mini', value: 'gpt-5-mini', webSearch: true, reasoning: true },
    { label: 'GPT-4.1', value: 'gpt-4.1', webSearch: true, reasoning: true },
    { label: 'GPT-4.1 Mini', value: 'gpt-4.1-mini', webSearch: true, reasoning: false },
    { label: 'GPT-4o', value: 'gpt-4o', webSearch: false, reasoning: true },
    { label: 'GPT-4o Mini', value: 'gpt-4o-mini', webSearch: false, reasoning: false },
] as const;

function AiChat() {
    const [model, setModel] = useState<string>(MODELS[0].value);
    const [stream] = useStreamSetting();
    const [webSearch, setWebSearch] = useWebSearchSetting();
    const [reasoning, setReasoning] = useReasoningSetting();
    const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');
    const [output, setOutput] = useState('');
    const [reasoningOutput, setReasoningOutput] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const chatMutation = tipcClient.ai.chat.useMutation();
    const selectedModel = MODELS.find((m) => m.value === model) ?? MODELS[0];

    const handleSend = async (prompt: string) => {
        if (!prompt) return;
        setLoading(true);
        setError(null);
        setOutput('');
        setReasoningOutput('');

        const id = crypto.randomUUID();
        const useWebSearch = webSearch && selectedModel.webSearch;
        const useReasoning = reasoning && selectedModel.reasoning;

        if (stream) {
            let received = '';
            const offChunk = rendererHandlers.onAiChunk.listen((data) => {
                if (data.id !== id) return;
                received += data.delta;
                setOutput((prev) => prev + data.delta);
            });
            const offReasoningChunk = rendererHandlers.onAiReasoningChunk.listen((data) => {
                if (data.id !== id) return;
                setReasoningOutput((prev) => prev + data.delta);
            });
            const offDone = rendererHandlers.onAiDone.listen((data) => {
                if (data.id !== id) return;
                if (!received) setError('Model returned no text (try disabling web search or switching models).');
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
                offReasoningChunk();
                offDone();
                offError();
            };

            await chatMutation.mutateAsync({ id, model, prompt, stream: true, webSearch: useWebSearch, reasoning: useReasoning, reasoningEffort });
            return;
        }

        const result = await chatMutation.mutateAsync({ id, model, prompt, stream: false, webSearch: useWebSearch, reasoning: useReasoning, reasoningEffort });
        setLoading(false);
        if (result?.error) {
            setError(result.error);
        } else {
            setOutput(result?.text ?? '');
            setReasoningOutput(result?.reasoning ?? '');
        }
    };

    return (
        <SidebarProvider>
            <AppSidebar />
            <SidebarInset className="min-w-0 pl-[9rem]">
                <div className="flex h-screen flex-col bg-background">
                    <div className={`flex-1 overflow-y-auto p-4 sm:p-6 ${!output && !error && !loading ? 'flex items-center justify-center' : ''}`}>
                        {!output && !error && !loading ? (
                            <h1 className="pointer-events-none cursor-default select-none text-3xl font-semibold tracking-tight text-slate-950 text-center [text-shadow:_0_0_10px_rgba(0,0,0,0.15)]">
                                Get started
                            </h1>
                        ) : (
                            <div className="mx-auto w-full max-w-2xl space-y-6">
                                {error && (
                                    <Alert variant="destructive">
                                        <AlertDescription>{error}</AlertDescription>
                                    </Alert>
                                )}
                                {reasoningOutput && (
                                    <Accordion type="single" collapsible>
                                        <AccordionItem value="reasoning">
                                            <AccordionTrigger className="text-xs text-muted-foreground">
                                                Thinking
                                            </AccordionTrigger>
                                            <AccordionContent>
                                                <MarkdownRenderer content={reasoningOutput} isStreaming={loading} className="text-xs text-muted-foreground" />
                                            </AccordionContent>
                                        </AccordionItem>
                                    </Accordion>
                                )}
                                <div className="min-h-40 text-sm leading-normal text-slate-800 break-words">
                                    <MarkdownRenderer content={output} isStreaming={loading} />
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="shrink-0 flex justify-center w-full p-4 sm:p-6 pt-0">
                        <div className="w-full max-w-[90%] sm:max-w-md md:max-w-lg lg:max-w-2xl min-w-[260px] mx-auto">
                            <PromptInputBox
                                onSend={handleSend}
                                isLoading={loading}
                                placeholder="Ask something..."
                                models={MODELS.map((m) => ({ label: m.label, value: m.value }))}
                                model={model}
                                onModelChange={setModel}
                                webSearch={webSearch && selectedModel.webSearch}
                                onWebSearchChange={setWebSearch}
                                webSearchDisabled={!selectedModel.webSearch}
                                reasoning={reasoning && selectedModel.reasoning}
                                onReasoningChange={setReasoning}
                                reasoningDisabled={!selectedModel.reasoning}
                                reasoningEffort={reasoningEffort}
                                onReasoningEffortChange={(v) => setReasoningEffort(v as ReasoningEffort)}
                                reasoningEfforts={[...REASONING_EFFORTS]}
                            />
                        </div>
                    </div>
                </div>
            </SidebarInset>
        </SidebarProvider>
    );
}
