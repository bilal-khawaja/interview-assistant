import {
    Sidebar,
    SidebarContent,
    SidebarHeader,
    SidebarInset,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarRail,
    useSidebar,
} from '@/components/ui/sidebar';
import { Link, useLocation } from '@tanstack/react-router';
import { IconHome, IconRobot, IconSettings, IconMicrophone } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import type { ComponentProps } from 'react';

export function AppSidebar() {
    const { pathname } = useLocation();

    return (
        <Sidebar
            className="[&_[data-sidebar=sidebar]]:m-0 [&_[data-sidebar=sidebar]]:rounded-l-none [&_[data-sidebar=sidebar]]:rounded-r-3xl [&_[data-sidebar=sidebar]]:border-none [&_[data-sidebar=sidebar]]:bg-[#f9faf9]"
        >
            <SidebarHeader className="px-4 py-6 text-xs font-medium tracking-wide text-slate-600 hover:text-slate-900">
                Interview-Assistant
            </SidebarHeader>
            <SidebarContent className="p-2">
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            asChild
                            isActive={pathname === '/'}
                            className="rounded-lg text-[10px] font-semibold tracking-wide text-slate-600 hover:bg-[#e6e6e6] hover:text-slate-900 data-[active=true]:bg-[#eef0ee] data-[active=true]:text-slate-900"
                        >
                            <Link to="/">
                                <IconHome className="size-2" />
                                Home
                            </Link>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            asChild
                            isActive={pathname === '/ai'}
                            className="rounded-lg text-[10px] font-semibold tracking-wide text-slate-600 hover:bg-[#e6e6e6] hover:text-slate-900 data-[active=true]:bg-[#eef0ee] data-[active=true]:text-slate-900"
                        >
                            <Link to="/ai">
                                <IconRobot className="size-2" />
                                Chatbot
                            </Link>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            asChild
                            isActive={pathname === '/realtime'}
                            className="rounded-lg text-[10px] font-semibold tracking-wide text-slate-600 hover:bg-[#e6e6e6] hover:text-slate-900 data-[active=true]:bg-[#eef0ee] data-[active=true]:text-slate-900"
                        >
                            <Link to="/realtime">
                                <IconMicrophone className="size-2" />
                                Realtime
                            </Link>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            asChild
                            isActive={pathname === '/settings'}
                            className="rounded-lg text-[10px] font-semibold tracking-wide text-slate-600 hover:bg-[#e6e6e6] hover:text-slate-900 data-[active=true]:bg-[#eef0ee] data-[active=true]:text-slate-900"
                        >
                            <Link to="/settings">
                                <IconSettings className="size-2" />
                                Settings
                            </Link>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarContent>
            <SidebarRail />
        </Sidebar>
    );
}

export function AppSidebarInset({ className, ...props }: ComponentProps<typeof SidebarInset>) {
    const { state, isMobile } = useSidebar();
    const gapped = !isMobile && state === 'expanded';

    return (
        <SidebarInset
            className={cn('w-full transition-[margin] duration-200 ease-linear', gapped && 'md:ml-36', className)}
            {...props}
        />
    );
}
