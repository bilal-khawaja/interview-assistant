import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { tipcInvoker } from '@/lib/tipc-client';

export function UpdateDialog() {
    const params = new URLSearchParams(window.location.search);
    const releaseNotes = params.get('notes') ?? '';

    return (
        <div className="flex h-screen w-screen flex-col justify-between bg-[#1c1c1e] p-6 text-white">
            <div className="space-y-3">
                <h1 className="text-lg font-semibold">Update available</h1>
                <ScrollArea className="max-h-64">
                    <p className="whitespace-pre-wrap text-sm text-white/70">
                        {releaseNotes || 'A new version has been downloaded and is ready to install.'}
                    </p>
                </ScrollArea>
            </div>
            <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => tipcInvoker.update.closeUpdateWindow()}>
                    Later
                </Button>
                <Button onClick={() => tipcInvoker.update.installUpdate()}>Restart & Install</Button>
            </div>
        </div>
    );
}
