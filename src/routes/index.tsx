import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useForm } from '@tanstack/react-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const signupSchema = z.object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.email('Enter a valid email'),
});

export const Route = createFileRoute('/')({
    component: App,
});

function App() {
    const [count, setCount] = useState(0);

    const form = useForm({
        defaultValues: { name: '', email: '' },
        validators: { onChange: signupSchema },
        onSubmit: ({ value }) => {
            alert(`Submitted: ${value.name} <${value.email}>`);
        },
    });

    return (
        <div className="flex min-h-screen items-center justify-center bg-background p-4">
            <div className="mx-auto w-full max-w-3xl space-y-6">
                {/* Header */}
                <div className="space-y-2 text-center">
                    <h1 className="text-4xl font-bold tracking-tight">
                        ⚡ Electron + Vite + React + shadcn/ui
                    </h1>
                    <p className="text-muted-foreground">
                        Built with the latest bleeding-edge technologies
                    </p>
                </div>

                {/* Tech Stack Cards */}
                <div className="grid gap-4 md:grid-cols-2">
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <span>🚀</span> Vite 8 (Rolldown)
                            </CardTitle>
                            <CardDescription>
                                Rust-based bundler for lightning-fast builds
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <Badge variant="secondary">10-30x faster</Badge>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <span>⚛️</span> React 19.2
                            </CardTitle>
                            <CardDescription>
                                Latest version with concurrent features
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <Badge variant="secondary">Concurrent Mode</Badge>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <span>🐹</span> TypeScript 7 (Go)
                            </CardTitle>
                            <CardDescription>
                                Go-based compiler with native speed
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <Badge variant="secondary">8-12x faster</Badge>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <span>🎨</span> Tailwind CSS v4
                            </CardTitle>
                            <CardDescription>
                                Latest utility-first CSS framework
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <Badge variant="secondary">Optimized</Badge>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <span>🧭</span> TanStack Router
                            </CardTitle>
                            <CardDescription>
                                Type-safe, file-based routing
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="flex items-center gap-2">
                            <Badge variant="secondary">Type-safe</Badge>
                            <Link to="/about">
                                <Button size="sm" variant="outline">
                                    Visit /about
                                </Button>
                            </Link>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <span>📋</span> TanStack Form + Zod
                            </CardTitle>
                            <CardDescription>
                                Type-safe forms with schema validation
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <Badge variant="secondary">Schema-validated</Badge>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <span>🤖</span> TanStack AI
                            </CardTitle>
                            <CardDescription>
                                Streaming OpenAI chat, runtime API key
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="flex items-center gap-2">
                            <Badge variant="secondary">Streaming</Badge>
                            <Link to="/ai">
                                <Button size="sm" variant="outline">
                                    Visit /ai
                                </Button>
                            </Link>
                        </CardContent>
                    </Card>
                </div>

                {/* Interactive Demo Card */}
                <Card className="border-2">
                    <CardHeader>
                        <CardTitle>🧩 shadcn/ui Components</CardTitle>
                        <CardDescription>
                            Beautiful, accessible, and customizable components
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex flex-wrap gap-2">
                            <Badge>Default</Badge>
                            <Badge variant="secondary">Secondary</Badge>
                            <Badge variant="outline">Outline</Badge>
                            <Badge variant="destructive">Destructive</Badge>
                        </div>

                        <div className="space-y-2">
                            <Button onClick={() => setCount((count) => count + 1)} className="w-full">
                                Count is {count}
                            </Button>
                            <p className="text-center text-sm text-muted-foreground">
                                Edit <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">src/App.tsx</code> to test HMR
                            </p>
                        </div>
                    </CardContent>
                </Card>

                {/* TanStack Form + Zod Demo */}
                <Card className="border-2">
                    <CardHeader>
                        <CardTitle>📋 TanStack Form + Zod</CardTitle>
                        <CardDescription>
                            Type-safe form state with schema validation
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form
                            className="space-y-4"
                            onSubmit={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                form.handleSubmit();
                            }}
                        >
                            <form.Field name="name">
                                {(field) => (
                                    <div className="space-y-1.5">
                                        <Label htmlFor={field.name}>Name</Label>
                                        <Input
                                            id={field.name}
                                            name={field.name}
                                            value={field.state.value}
                                            onBlur={field.handleBlur}
                                            onChange={(e) => field.handleChange(e.target.value)}
                                        />
                                        {field.state.meta.errors.length > 0 && (
                                            <p className="text-sm text-destructive">
                                                {field.state.meta.errors.map((e) => e?.message).join(', ')}
                                            </p>
                                        )}
                                    </div>
                                )}
                            </form.Field>

                            <form.Field name="email">
                                {(field) => (
                                    <div className="space-y-1.5">
                                        <Label htmlFor={field.name}>Email</Label>
                                        <Input
                                            id={field.name}
                                            name={field.name}
                                            type="email"
                                            value={field.state.value}
                                            onBlur={field.handleBlur}
                                            onChange={(e) => field.handleChange(e.target.value)}
                                        />
                                        {field.state.meta.errors.length > 0 && (
                                            <p className="text-sm text-destructive">
                                                {field.state.meta.errors.map((e) => e?.message).join(', ')}
                                            </p>
                                        )}
                                    </div>
                                )}
                            </form.Field>

                            <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting]}>
                                {([canSubmit, isSubmitting]) => (
                                    <Button type="submit" className="w-full" disabled={!canSubmit}>
                                        {isSubmitting ? 'Submitting...' : 'Submit'}
                                    </Button>
                                )}
                            </form.Subscribe>
                        </form>
                    </CardContent>
                </Card>

                {/* Footer */}
                <div className="space-y-2 text-center">
                    <p className="text-sm text-muted-foreground">
                        Powered by <strong>Electron Forge</strong> with security best practices
                    </p>
                    <div className="flex items-center justify-center gap-2">
                        <Badge variant="outline">Context Isolation</Badge>
                        <Badge variant="outline">No Node Integration</Badge>
                        <Badge variant="outline">Secure IPC</Badge>
                    </div>
                </div>
            </div>
        </div>
    );
}
