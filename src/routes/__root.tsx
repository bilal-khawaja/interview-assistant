import { createRootRoute, Outlet } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CSSProperties } from 'react';

const queryClient = new QueryClient();

export const Route = createRootRoute({
    component: () => (
        <QueryClientProvider client={queryClient}>
            <div
                className="fixed top-0 left-0 right-0 h-8 z-50"
                style={{ WebkitAppRegion: 'drag' } as CSSProperties}
            />
            <Outlet />
        </QueryClientProvider>
    ),
});
