import { Button } from '@/components/ui/button';
import { tipcInvoker } from '@/lib/tipc-client';

export function UpgradeDialog() {
    const params = new URLSearchParams(window.location.search);
    const previousVersion = params.get('previousVersion') || null;
    const currentVersion = params.get('currentVersion') ?? '';

    return (
        <div className="flex h-screen w-screen flex-col justify-between bg-[#1c1c1e] p-6 text-white">
            <div className="space-y-3">
                <h1 className="text-lg font-semibold">
                    {previousVersion ? 'New version installed' : 'Welcome'}
                </h1>
                <p className="text-sm text-white/70">
                    {previousVersion
                        ? `Updated from ${previousVersion} to ${currentVersion}.`
                        : `First run — version ${currentVersion}.`}
                </p>
            </div>
            <div className="flex justify-end gap-2">
                <Button variant="destructive" onClick={() => tipcInvoker.upgrade.resetAndRelaunch()}>
                    Reset data
                </Button>
                <Button onClick={() => tipcInvoker.upgrade.keepAndContinue()}>Continue</Button>
            </div>
        </div>
    );
}
