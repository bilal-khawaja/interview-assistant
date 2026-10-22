import { Outlet, createFileRoute } from '@tanstack/react-router';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import type { CSSProperties } from 'react';
import { AppSidebar, AppSidebarInset } from '@/layout/sidebar';
import { ScrollArea } from '@/components/ui/scroll-area';

export const Route = createFileRoute('/settings')({
    component: SettingsLayout,
});

function SettingsLayout() {
    return (
        <SidebarProvider style={{ '--sidebar-width': '18rem' } as CSSProperties}>
            <AppSidebar />
            <AppSidebarInset className="flex h-screen min-w-0 flex-1 flex-col overflow-hidden">
                <SidebarTrigger className="m-2 shrink-0" />
                <ScrollArea className="min-h-0 flex-1 bg-background">
                    <Outlet />
                </ScrollArea>
            </AppSidebarInset>
        </SidebarProvider>
    );
}
