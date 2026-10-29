import { createRootRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type CSSProperties } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/lib/auth-client';
import { guardRedirect } from '@/lib/auth-guard';
import { startAppSession } from '@/lib/session-client';

const queryClient = new QueryClient();

export const Route = createRootRoute({
    component: RootLayout,
});

function RootLayout() {
    // Which account is signed in decides what every store holds, so it is wired once here
    // rather than per page.
    useEffect(() => startAppSession(), []);

    const { auth } = useAuth();
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const navigate = useNavigate();
    const redirect = guardRedirect(auth, pathname);

    useEffect(() => {
        if (redirect) void navigate({ to: redirect, replace: true });
    }, [redirect, navigate]);

    // Nothing from a signed-out window's pages shows while the session is checked or the
    // redirect is on its way.
    const blocked = auth.status === 'unknown' || redirect !== null;

    return (
        <QueryClientProvider client={queryClient}>
            <div
                className="fixed top-0 left-0 right-0 h-8 z-50"
                style={{ WebkitAppRegion: 'drag' } as CSSProperties}
            />
            {blocked ? (
                <div className="flex h-screen items-center justify-center bg-background">
                    <Spinner className="size-6 text-muted-foreground" />
                </div>
            ) : (
                <Outlet />
            )}
        </QueryClientProvider>
    );
}
