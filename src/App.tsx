import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

function App() {
    const [count, setCount] = useState(0);

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

export default App;
