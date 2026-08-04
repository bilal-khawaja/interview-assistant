import { useEffect, useState, type CSSProperties } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { tipcClient, tipcInvoker, rendererHandlers } from '@/lib/tipc-client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from '@/layout/sidebar';
import { useStreamSetting } from '@/lib/use-stream-setting';
import { useWebSearchSetting } from '@/lib/use-web-search-setting';
import { useReasoningSetting } from '@/lib/use-reasoning-setting';
import { useChatTabsStore } from '@/lib/chat-tabs-store';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { PromptInputBox } from '@/components/ui/ai-prompt-box';
import { cn } from '@/lib/utils';
import {
    ChainOfThought,
    ChainOfThoughtContent,
    ChainOfThoughtStep,
    
} from '@/components/ai-elements/chain-of-thought';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Globe, BrainCog, Plus, X } from 'lucide-react';
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

function TabBar() {
    const tabs = useChatTabsStore((s) => s.tabs);
    const activeTabId = useChatTabsStore((s) => s.activeTabId);
    const setActiveTabId = useChatTabsStore((s) => s.setActiveTabId);
    const closeTab = useChatTabsStore((s) => s.closeTab);
    const createTab = useChatTabsStore((s) => s.createTab);

    if (!activeTabId) return null;

    return (
        <div
            className="flex items-center gap-1 border-b border-border px-4 py-2 overflow-x-auto"
            style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        >
            <div className="inline-flex items-center gap-1 rounded-md bg-muted/40 p-1">
                {tabs.map((tab) => (
                    <div
                        key={tab.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setActiveTabId(tab.id)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') setActiveTabId(tab.id);
                        }}
                        className={cn(
                            'relative flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 pr-7 text-sm font-medium',
                            tab.id === activeTabId
                                ? 'bg-background text-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground'
                        )}
                    >
                        <span className="max-w-[160px] truncate">{tab.title}</span>
                        <span
                            role="button"
                            tabIndex={-1}
                            aria-label={`Close ${tab.title}`}
                            className="absolute right-2 flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-black/10 hover:text-foreground"
                            onClick={(e) => {
                                e.stopPropagation();
                                closeTab(tab.id);
                            }}
                        >
                            <X className="h-3 w-3" />
                        </span>
                    </div>
                ))}
            </div>
            <button
                type="button"
                aria-label="New chat"
                onClick={() => createTab(MODELS[0].value)}
                className="flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-muted/50"
            >
                <Plus className="h-4 w-4" />
            </button>
        </div>
    );
}

function AiChat() {
    const tabs = useChatTabsStore((s) => s.tabs);
    const activeTabId = useChatTabsStore((s) => s.activeTabId);
    const createTab = useChatTabsStore((s) => s.createTab);
    const setActiveTabId = useChatTabsStore((s) => s.setActiveTabId);
    const appendUserMessage = useChatTabsStore((s) => s.appendUserMessage);
    const appendStreamChunk = useChatTabsStore((s) => s.appendStreamChunk);
    const finalizeStream = useChatTabsStore((s) => s.finalizeStream);
    const setNonStreamResult = useChatTabsStore((s) => s.setNonStreamResult);
    const setError = useChatTabsStore((s) => s.setError);
    const setStreaming = useChatTabsStore((s) => s.setStreaming);
    const updateTabTitle = useChatTabsStore((s) => s.updateTabTitle);

    const [model, setModel] = useState<string>(MODELS[0].value);
    const [stream] = useStreamSetting();
    const [webSearch, setWebSearch] = useWebSearchSetting();
    const [reasoning, setReasoning] = useReasoningSetting();
    const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');
    const [activeThought, setActiveThought] = useState<{ webSearch: boolean; reasoning: boolean } | null>(null);

    const chatMutation = tipcClient.ai.chat.useMutation();
    const selectedModel = MODELS.find((m) => m.value === model) ?? MODELS[0];

    const [hasHydrated, setHasHydrated] = useState(() => useChatTabsStore.persist.hasHydrated());

    useEffect(() => {
        if (hasHydrated) return;
        return useChatTabsStore.persist.onFinishHydration(() => setHasHydrated(true));
    }, [hasHydrated]);

    useEffect(() => {
        if (!hasHydrated) return;
        if (tabs.length === 0) createTab(model);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hasHydrated]);

    const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

    const readFileAsBase64 = (file: File): Promise<string> =>
        new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result as string;
                resolve(result.split(',')[1] ?? '');
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });

    const handleSend = async (prompt: string, files?: File[]) => {
        if (!prompt && !files?.length) return;

        let tabId = activeTabId;
        if (!tabId) {
            tabId = createTab(model);
            setActiveTabId(tabId);
        }
        const tab = useChatTabsStore.getState().tabs.find((t) => t.id === tabId);
        const isFirstMessage = !tab || tab.messages.length === 0;

        appendUserMessage(tabId, prompt);
        setStreaming(tabId, true);

        if (isFirstMessage) {
            tipcInvoker.ai.titleChat({ prompt }).then((res) => {
                if (res?.title) updateTabTitle(tabId!, res.title);
            });
        }

        const id = crypto.randomUUID();
        const useWebSearch = webSearch && selectedModel.webSearch;
        const useReasoning = reasoning && selectedModel.reasoning;
        setActiveThought({ webSearch: useWebSearch, reasoning: useReasoning });
        const attachments = files?.length
            ? await Promise.all(
                  files.map(async (file) => ({
                      name: file.name,
                      mimeType: file.type,
                      data: await readFileAsBase64(file),
                  }))
              )
            : undefined;

        if (stream) {
            let received = '';
            const offChunk = rendererHandlers.onAiChunk.listen((data) => {
                if (data.id !== id) return;
                received += data.delta;
                appendStreamChunk(tabId!, 'text', data.delta);
                setActiveThought(null);
            });
            const offReasoningChunk = rendererHandlers.onAiReasoningChunk.listen(() => {});
            const offDone = rendererHandlers.onAiDone.listen((data) => {
                if (data.id !== id) return;
                if (!received) setError(tabId!, 'Model returned no text (try disabling web search or switching models).');
                finalizeStream(tabId!);
                setActiveThought(null);
                cleanup();
            });
            const offError = rendererHandlers.onAiError.listen((data) => {
                if (data.id !== id) return;
                setError(tabId!, data.message);
                setActiveThought(null);
                cleanup();
            });
            const cleanup = () => {
                offChunk();
                offReasoningChunk();
                offDone();
                offError();
            };

            await chatMutation.mutateAsync({ id, model, prompt, stream: true, webSearch: useWebSearch, reasoning: useReasoning, reasoningEffort, attachments });
            return;
        }

        const result = await chatMutation.mutateAsync({ id, model, prompt, stream: false, webSearch: useWebSearch, reasoning: useReasoning, reasoningEffort, attachments });
        setActiveThought(null);
        if (result?.error) {
            setError(tabId, result.error);
        } else {
            setNonStreamResult(tabId, result?.text ?? '', result?.reasoning);
        }
    };

    if (!activeTab) return null;

    const isEmpty = activeTab.messages.length === 0 && !activeTab.streamingText && !activeTab.error && !activeThought;

    return (
        <SidebarProvider>
            <AppSidebar />
            <SidebarInset className="min-w-0 pl-[9rem]">
                <div className="flex h-screen flex-col bg-background">
                    <TabBar />
                    <div className={`flex-1 overflow-y-auto p-4 sm:p-6 ${isEmpty ? 'flex items-center justify-center' : ''}`}>
                        {isEmpty ? (
                            <h1 className="pointer-events-none cursor-default select-none text-3xl font-semibold tracking-tight text-slate-950 text-center [text-shadow:_0_0_10px_rgba(0,0,0,0.15)]">
                                Get started
                            </h1>
                        ) : (
                            <div className="mx-auto w-full max-w-2xl space-y-6">
                                {activeTab.messages.map((message, index) => (
                                    <div key={index} className={message.role === 'user' ? 'text-right' : ''}>
                                        {message.role === 'user' ? (
                                            <span className="inline-block rounded-2xl bg-muted px-4 py-2 text-sm text-foreground">
                                                {message.content}
                                            </span>
                                        ) : (
                                            <div className="text-sm leading-normal text-slate-800 break-words">
                                                <MarkdownRenderer content={message.content} isStreaming={false} />
                                            </div>
                                        )}
                                    </div>
                                ))}

                                {activeThought && !activeTab.streamingText && (
                                    <ChainOfThought defaultOpen>
                                        <ChainOfThoughtContent>
                                            {activeThought.webSearch ? (
                                                <ChainOfThoughtStep
                                                    icon={Globe}
                                                    label={<Shimmer>Searching the web...</Shimmer>}
                                                    status="active"
                                                />
                                            ) : activeThought.reasoning ? (
                                                <ChainOfThoughtStep
                                                    icon={BrainCog}
                                                    label={<Shimmer>Generating Response...</Shimmer>}
                                                    status="active"
                                                />
                                            ) : null}
                                        </ChainOfThoughtContent>
                                    </ChainOfThought>
                                )}
                                {activeTab.error && (
                                    <Alert variant="destructive">
                                        <AlertDescription>{activeTab.error}</AlertDescription>
                                    </Alert>
                                )}
                                {activeTab.streamingText && (
                                    <div className="min-h-40 text-sm leading-normal text-slate-800 break-words">
                                        <MarkdownRenderer content={activeTab.streamingText} isStreaming={activeTab.isStreaming} />
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="shrink-0 flex justify-center w-full p-4 sm:p-6 pt-0">
                        <div className="w-full max-w-[90%] sm:max-w-md md:max-w-lg lg:max-w-2xl min-w-[260px] mx-auto">
                            <PromptInputBox
                                onSend={handleSend}
                                isLoading={activeTab.isStreaming}
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
