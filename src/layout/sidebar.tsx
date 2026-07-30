import {
    Sidebar,
    SidebarContent,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from '@/components/ui/sidebar';
import { Link, useLocation } from '@tanstack/react-router';
import { IconHome, IconRobot, IconSettings, IconMicrophone } from '@tabler/icons-react';
import type { CSSProperties } from 'react';

export function AppSidebar() {
    const { pathname } = useLocation();

    return (
        <Sidebar
            style={{ '--sidebar-width': '18rem' } as CSSProperties}
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
                    {/* <SidebarMenuItem>
                        <SidebarMenuButton
                            asChild
                            className="rounded-lg font-sm tracking-wide text-slate-600 hover:bg-[#f4f5f4] hover:text-slate-900"
                        >
                            <Link to="/realtime">Realtime</Link>
                        </SidebarMenuButton>
                    </SidebarMenuItem> */}
                </SidebarMenu>
            </SidebarContent>
        </Sidebar>
    );
}
