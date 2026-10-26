import { createRootRoute, Outlet } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type CSSProperties } from 'react';
import { transcriptStore } from '@/lib/transcript-client';

const queryClient = new QueryClient();

export const Route = createRootRoute({
    component: RootLayout,
});

function RootLayout() {
    // Meeting state lives for the whole window, so it connects once here rather than per page.
    useEffect(() => {
        void transcriptStore.init();
    }, []);

    return (
        <QueryClientProvider client={queryClient}>
            <div
                className="fixed top-0 left-0 right-0 h-8 z-50"
                style={{ WebkitAppRegion: 'drag' } as CSSProperties}
            />
            <Outlet />
        </QueryClientProvider>
    );
}
