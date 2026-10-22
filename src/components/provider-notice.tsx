import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export function NotWiredNotice() {
    return (
        <Alert>
            <AlertDescription>
                Not saved yet. Values entered here stay on this page, and keys are still read from the environment.
            </AlertDescription>
        </Alert>
    );
}

export function SaveBar() {
    return (
        <div className="flex justify-end">
            <Button disabled>Save changes</Button>
        </div>
    );
}
