import { createFileRoute } from '@tanstack/react-router';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from '@/layout/sidebar';
import { useStreamSetting } from '@/lib/use-stream-setting';
import { useOpacitySetting } from '@/lib/use-opacity-setting';
import { useClickThroughSetting } from '@/lib/use-click-through-setting';

export const Route = createFileRoute('/settings')({
    component: Settings,
});

function Settings() {
    const [stream, setStream] = useStreamSetting();
    const [opacity, setOpacity] = useOpacitySetting();
    const [clickThrough, setClickThrough] = useClickThroughSetting();

    return (
        <SidebarProvider>
            <AppSidebar />
            <SidebarInset className="min-w-0 flex-1 pl-[9rem]"> 
                <div className="min-h-screen bg-background p-6">
                    <div className="mx-auto w-full max-w-2xl space-y-4 py-8">
                            <h1 className="text-xl font-bold">Settings</h1>

                            <div className="flex w-full items-center justify-between gap-4 rounded-xl border border-border/60 bg-[#f9faf9] px-4 py-3 shadow-sm">                            <span className="text-sm text-black">Streaming response</span>
                                <button
                                    type="button"
                                    onClick={() => setStream((s) => !s)}
                                    aria-pressed={stream}
                                    className={`relative h-5 w-12 shrink-0 rounded-full p-[2px] transition-colors duration-300 ease-in-out ${
                                        stream ? 'bg-[#34C759]' : 'bg-[#E9E9EA]'
                                    }`}
                                >
                                    <span
                                        className={`absolute top-[2px] left-[2px] size-4 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)] transition-transform duration-300 ease-in-out ${
                                            stream ? 'translate-x-[1.75rem]' : 'translate-x-0'
                                        }`}
                                    />
                                </button>
                        </div>

                        <div className="flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-[#f9faf9] px-4 py-3 shadow-sm">
                            <span className="text-sm text-black">Window opacity</span>
                            <div className="flex items-center gap-3">
                                <span className="w-10 text-right text-xs text-muted-foreground">
                                    {Math.round(opacity * 100)}%
                                </span>\
                                <input
                                    type="range"
                                    min={0.2}
                                    max={1}
                                    step={0.05}
                                    value={opacity}
                                    onChange={(e) => setOpacity(Number(e.target.value))}
                                    className="w-32 accent-[#34C759]"
                                />

                            </div>
                        </div>

                        <div className="flex items-center justify-between rounded-xl border border-border/60 bg-[#f9faf9] px-4 py-3 shadow-sm">
                            <div>
                                <span className="text-sm text-black">Click-through</span>
                                {clickThrough && (
                                    <p className="text-xs text-muted-foreground">
                                        Press Ctrl+Shift+X to regain control
                                    </p>
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={() => setClickThrough((c) => !c)}
                                aria-pressed={clickThrough}
                                className={`relative h-5 w-12 shrink-0 rounded-full p-[2px] transition-colors duration-300 ease-in-out ${
                                    clickThrough ? 'bg-[#34C759]' : 'bg-[#E9E9EA]'
                                }`}
                            >
                                <span
                                    className={`absolute top-[2px] left-[2px] size-4 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)] transition-transform duration-300 ease-in-out ${
                                        clickThrough ? 'translate-x-[1.75rem]' : 'translate-x-0'
                                    }`}
                                />
                            </button>
                        </div>
                    </div>
                </div>
            </SidebarInset>
        </SidebarProvider>
    );
}
