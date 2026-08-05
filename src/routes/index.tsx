import { createFileRoute, Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar, AppSidebarInset } from '@/layout/sidebar';
import type { CSSProperties } from 'react';

export const Route = createFileRoute('/')({
    component: App,
});

function App() {
    return (
        <SidebarProvider style={{ '--sidebar-width': '18rem' } as CSSProperties}>
            <AppSidebar />
            <AppSidebarInset>
                <SidebarTrigger className="m-2" />
                <div className="flex flex-1 flex-col items-start justify-start gap-4 bg-background px-10 pt-30 text-left">
                    <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
                        Welcome to Interview-Assistant
                    </h1>
                    <p className="mt-0.5 max-w-xl text-sm leading-relaxed text-slate-500">
                        Interview-Assistant delivers realtime AI support during your meetings and
                        interviews, alongside a dedicated chatbot for on-demand guidance — helping you
                        stay sharp, prepared, and confident at every step. Get started now
                    </p>
                    <Link to="/realtime">
                        <Button size="sm" variant="outline">
                            Realtime Assistant
                        </Button>
                    </Link>
                </div>
            </AppSidebarInset>
        </SidebarProvider>
    );
}
