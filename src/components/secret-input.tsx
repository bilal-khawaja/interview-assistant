import { useState, type ComponentProps } from 'react';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function SecretInput(props: Omit<ComponentProps<typeof Input>, 'type'>) {
    const [visible, setVisible] = useState(false);

    return (
        <div className="flex gap-2">
            <Input type={visible ? 'text' : 'password'} autoComplete="off" {...props} />
            <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={visible ? 'Hide value' : 'Show value'}
                onClick={() => setVisible((v) => !v)}
            >
                {visible ? <IconEyeOff className="size-4" /> : <IconEye className="size-4" />}
            </Button>
        </div>
    );
}
