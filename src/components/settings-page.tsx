import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Children } from 'react';

export function SettingsPage({ title, description, children }: { title: string; description: string; children: ReactNode }) {
    return (
        <div className="mx-auto w-full max-w-2xl space-y-4 p-6 py-8">
            <div className="space-y-1">
                <h1 className="text-xl font-bold">{title}</h1>
                <p className="text-sm text-muted-foreground">{description}</p>
            </div>
            {children}
        </div>
    );
}

export function SettingsSection({ title, description, children }: { title?: string; description?: string; children: ReactNode }) {
    const rows = Children.toArray(children);

    return (
        <Card>
            {(title || description) && (
                <CardHeader>
                    {title && <CardTitle className="text-base">{title}</CardTitle>}
                    {description && <CardDescription>{description}</CardDescription>}
                </CardHeader>
            )}
            <CardContent className={title || description ? undefined : 'pt-6'}>
                {rows.map((row, i) => (
                    <div key={i}>
                        {i > 0 && <Separator className="my-4" />}
                        {row}
                    </div>
                ))}
            </CardContent>
        </Card>
    );
}

export function SettingRow({
    label,
    description,
    htmlFor,
    children,
}: {
    label: string;
    description?: string;
    htmlFor?: string;
    children: ReactNode;
}) {
    return (
        <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
                <Label htmlFor={htmlFor}>{label}</Label>
                {description && <p className="text-xs text-muted-foreground">{description}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-3">{children}</div>
        </div>
    );
}

export function SettingField({
    label,
    description,
    htmlFor,
    children,
}: {
    label: string;
    description?: string;
    htmlFor?: string;
    children: ReactNode;
}) {
    return (
        <div className="space-y-2">
            <div className="space-y-0.5">
                <Label htmlFor={htmlFor}>{label}</Label>
                {description && <p className="text-xs text-muted-foreground">{description}</p>}
            </div>
            {children}
        </div>
    );
}
