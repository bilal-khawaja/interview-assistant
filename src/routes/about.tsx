import { createFileRoute, Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const Route = createFileRoute('/about')({
    component: About,
});

function About() {
    return (
        <div className="flex min-h-screen items-center justify-center bg-background p-4">
            <div className="mx-auto w-full max-w-lg space-y-6">
                <Card>
                    <CardHeader>
                        <CardTitle>🧭 About</CardTitle>
                        <CardDescription>
                            Second route, proving TanStack Router navigation works.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Link to="/">
                            <Button className="w-full">Back to home</Button>
                        </Link>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
