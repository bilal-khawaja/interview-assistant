import { useEffect, useState, type CSSProperties } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { tipcClient, tipcInvoker, rendererHandlers } from '@/lib/tipc-client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { AppSidebar, AppSidebarInset } from '@/layout/sidebar';
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
import { Globe, BrainCog, Plus, X, MoreVertical, Columns2 } from 'lucide-react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
    const pinnedTabId = useChatTabsStore((s) => s.pinnedTabId);
    const setActiveTabId = useChatTabsStore((s) => s.setActiveTabId);
    const setPinnedTabId = useChatTabsStore((s) => s.setPinnedTabId);
    const closeTab = useChatTabsStore((s) => s.closeTab);
    const createTab = useChatTabsStore((s) => s.createTab);
    const createBrowserTab = useChatTabsStore((s) => s.createBrowserTab);

    if (!activeTabId) return null;

    return (
        <div
            className="flex items-center gap-1 border-b border-border px-2 py-1"
            style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        >
            <SidebarTrigger className="-ml-1 size-9" />
            <Separator orientation="vertical" className="mr-1 h-4" />
            <div
                className="no-scrollbar min-w-0 overflow-x-auto whitespace-nowrap"
                onWheel={(e) => {
                    if (e.deltaY === 0) return;
                    e.currentTarget.scrollLeft += e.deltaY;
                }}
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
                                'relative flex cursor-pointer items-center gap-2 rounded-md mb-1 px-4 py-3.5 pr-16 text-sm font-medium',
                                tab.id === activeTabId
                                    ? 'bg-background text-foreground shadow-sm'
                                    : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            <span className="max-w-[160px] truncate">{tab.title}</span>
                            {tab.type !== 'browser' && (
                                <span
                                    role="button"
                                    tabIndex={-1}
                                    aria-label={
                                        pinnedTabId === tab.id ? `Unpin ${tab.title}` : `Open ${tab.title} in split view`
                                    }
                                    className={cn(
                                        'absolute right-8 flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-black/10 hover:text-foreground',
                                        pinnedTabId === tab.id && 'text-foreground bg-black/10'
                                    )}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (pinnedTabId === tab.id) {
                                            setPinnedTabId(null);
                                            return;
                                        }
                                        if (tab.id === activeTabId) {
                                            // Splitting the active tab against itself is a no-op — open a
                                            // fresh chat pinned alongside it instead, keeping this tab active.
                                            const newTabId = createTab(MODELS[0].value);
                                            setPinnedTabId(newTabId);
                                            setActiveTabId(tab.id);
                                            return;
                                        }
                                        setPinnedTabId(tab.id);
                                    }}
                                >
                                    <Columns2 className="h-3.5 w-3.5" />
                                </span>
                            )}
                            <span
                                role="button"
                                tabIndex={-1}
                                aria-label={`Close ${tab.title}`}
                                className="absolute right-1 flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-black/10 hover:text-foreground"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    closeTab(tab.id);
                                }}
                            >
                                <X className="h-3.5 w-3.5" />
                            </span>
                        </div>
                    ))}
                </div>
            </div>
            <button
                type="button"
                aria-label="New chat"
                onClick={() => createTab(MODELS[0].value)}
                className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50"
            >
                <Plus className="h-4 w-4" />
            </button>
            <div className="ml-auto">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            aria-label="More options"
                            className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50"
                        >
                            <MoreVertical className="h-4 w-4" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
                        <DropdownMenuItem onClick={() => createBrowserTab()}>
                            Open Browser
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </div>
    );
}

function ChatPane({ tabId }: { tabId: string }) {
    const tabs = useChatTabsStore((s) => s.tabs);
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

    const tab = tabs.find((t) => t.id === tabId);

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

        let id = tabId;
        if (!id) {
            id = createTab(model);
            setActiveTabId(id);
        }
        const currentTab = useChatTabsStore.getState().tabs.find((t) => t.id === id);
        const isFirstMessage = !currentTab || currentTab.messages.length === 0;

        appendUserMessage(id, prompt);
        setStreaming(id, true);

        if (isFirstMessage) {
            tipcInvoker.ai.titleChat({ prompt }).then((res) => {
                if (res?.title) updateTabTitle(id!, res.title);
            });
        }

        const requestId = crypto.randomUUID();
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
                if (data.id !== requestId) return;
                received += data.delta;
                appendStreamChunk(id!, 'text', data.delta);
                setActiveThought(null);
            });
            const offReasoningChunk = rendererHandlers.onAiReasoningChunk.listen(() => {});
            const offDone = rendererHandlers.onAiDone.listen((data) => {
                if (data.id !== requestId) return;
                if (!received) setError(id!, 'Model returned no text (try disabling web search or switching models).');
                finalizeStream(id!);
                setActiveThought(null);
                cleanup();
            });
            const offError = rendererHandlers.onAiError.listen((data) => {
                if (data.id !== requestId) return;
                setError(id!, data.message);
                setActiveThought(null);
                cleanup();
            });
            const cleanup = () => {
                offChunk();
                offReasoningChunk();
                offDone();
                offError();
            };

            await chatMutation.mutateAsync({
                id: requestId,
                model,
                prompt,
                stream: true,
                webSearch: useWebSearch,
                reasoning: useReasoning,
                reasoningEffort,
                attachments,
            });
            return;
        }

        const result = await chatMutation.mutateAsync({
            id: requestId,
            model,
            prompt,
            stream: false,
            webSearch: useWebSearch,
            reasoning: useReasoning,
            reasoningEffort,
            attachments,
        });
        setActiveThought(null);
        if (result?.error) {
            setError(id, result.error);
        } else {
            setNonStreamResult(id, result?.text ?? '', result?.reasoning);
        }
    };

    if (!tab) return null;

    if (tab.type === 'browser') {
        return (
            <div className="min-h-0 flex-1">
                <webview src={tab.url} style={{ display: 'flex', width: '100%', height: '100%' }} />
            </div>
        );
    }

    const isEmpty = tab.messages.length === 0 && !tab.streamingText && !tab.error && !activeThought;

    return (
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
            <ScrollArea className={`mt-2 flex-1 ${isEmpty ? 'flex items-center justify-center' : ''}`}>
                <div className="p-4 sm:p-6">
                    {isEmpty ? (
                        <h1 className="pointer-events-none cursor-default select-none text-3xl font-semibold tracking-tight text-slate-950 text-center [text-shadow:_0_0_10px_rgba(0,0,0,0.15)]">
                            Get started
                        </h1>
                    ) : (
                        <div className="mx-auto w-full max-w-2xl space-y-6">
                            {tab.messages.map((message, index) => (
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

                            {activeThought && !tab.streamingText && (
                                <ChainOfThought defaultOpen>
                                    <ChainOfThoughtContent>
                                        {activeThought.webSearch ? (
                                            <ChainOfThoughtStep
                                                icon={Globe}
                                                label={<Shimmer>Searching the web...</Shimmer>}
                                                status="active"
                                            />
                                        ) : (
                                            <ChainOfThoughtStep
                                                icon={BrainCog}
                                                label={<Shimmer>Generating Response...</Shimmer>}
                                                status="active"
                                            />
                                        )}
                                    </ChainOfThoughtContent>
                                </ChainOfThought>
                            )}
                            {tab.error && (
                                <Alert variant="destructive">
                                    <AlertDescription>{tab.error}</AlertDescription>
                                </Alert>
                            )}
                            {tab.streamingText && (
                                <div className="min-h-40 text-sm leading-normal text-slate-800 break-words">
                                    <MarkdownRenderer content={tab.streamingText} isStreaming={tab.isStreaming} />
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </ScrollArea>

            <div className="shrink-0 flex justify-center w-full p-4 sm:p-6 pt-0">
                <div className="w-full max-w-[90%] sm:max-w-md md:max-w-lg lg:max-w-2xl min-w-[260px] mx-auto">
                    <PromptInputBox
                        onSend={handleSend}
                        isLoading={tab.isStreaming}
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
    );
}

function AiChat() {
    const tabs = useChatTabsStore((s) => s.tabs);
    const activeTabId = useChatTabsStore((s) => s.activeTabId);
    const pinnedTabId = useChatTabsStore((s) => s.pinnedTabId);
    const createTab = useChatTabsStore((s) => s.createTab);

    const [model] = useState<string>(MODELS[0].value);
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
    const pinnedTab = pinnedTabId && pinnedTabId !== activeTab?.id ? tabs.find((t) => t.id === pinnedTabId) : null;

    if (!activeTab) return null;

    return (
        <SidebarProvider style={{ '--sidebar-width': '18rem' } as CSSProperties}>
            <AppSidebar />
            <AppSidebarInset className="min-w-0 overflow-hidden">
                <div className="flex h-screen flex-col overflow-hidden bg-background">
                    <TabBar />
                    {pinnedTab ? (
                        <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
                            <ResizablePanel defaultSize={50} minSize={25}>
                                <ChatPane tabId={activeTab.id} />
                            </ResizablePanel>
                            <ResizableHandle withHandle />
                            <ResizablePanel defaultSize={50} minSize={25}>
                                <ChatPane tabId={pinnedTab.id} />
                            </ResizablePanel>
                        </ResizablePanelGroup>
                    ) : (
                        <ChatPane tabId={activeTab.id} />
                    )}
                </div>
            </AppSidebarInset>
        </SidebarProvider>
    );
}
