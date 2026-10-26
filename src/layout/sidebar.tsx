import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarInset,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarMenuSub,
    SidebarMenuSubButton,
    SidebarMenuSubItem,
    useSidebar,
} from '@/components/ui/sidebar';
import { Link, useLocation } from '@tanstack/react-router';
import { IconChevronRight, IconHome, IconRobot, IconSettings, IconMicrophone, IconUsersGroup } from '@tabler/icons-react';
import { useMeetings } from '@/lib/transcript-client';
import { cn } from '@/lib/utils';
import { SETTINGS_BACK, SETTINGS_NAV, type SettingsNavGroup } from '@/lib/settings-nav';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { ComponentProps } from 'react';

const NAV_BUTTON_CLASS =
    'rounded-lg text-[10px] font-semibold tracking-wide text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground';

function SettingsDropdown({ group, pathname }: { group: SettingsNavGroup; pathname: string }) {
    const GroupIcon = group.icon;
    const hasActive = group.items.some((item) => pathname === item.to);

    return (
        <Collapsible defaultOpen={hasActive} className="group/collapsible">
            <SidebarMenuItem>
                <CollapsibleTrigger asChild>
                    <SidebarMenuButton className={NAV_BUTTON_CLASS}>
                        {GroupIcon && <GroupIcon className="size-2" />}
                        {group.label}
                        <IconChevronRight className="ml-auto size-2 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                    </SidebarMenuButton>
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <SidebarMenuSub>
                        {group.items.map((item) => (
                            <SidebarMenuSubItem key={item.to}>
                                <SidebarMenuSubButton
                                    asChild
                                    isActive={pathname === item.to}
                                    className="text-[10px] font-semibold tracking-wide text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground"
                                >
                                    <Link to={item.to}>
                                        <item.icon className="size-2" />
                                        <span>{item.label}</span>
                                    </Link>
                                </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                        ))}
                    </SidebarMenuSub>
                </CollapsibleContent>
            </SidebarMenuItem>
        </Collapsible>
    );
}

function SettingsNav({ pathname }: { pathname: string }) {
    const BackIcon = SETTINGS_BACK.icon;

    return (
        <>
            <SidebarMenu>
                <SidebarMenuItem>
                    <SidebarMenuButton asChild className={NAV_BUTTON_CLASS}>
                        <Link to={SETTINGS_BACK.to}>
                            <BackIcon className="size-2" />
                            {SETTINGS_BACK.label}
                        </Link>
                    </SidebarMenuButton>
                </SidebarMenuItem>
                {SETTINGS_NAV.filter((g) => g.collapsible).map((group) => (
                    <SettingsDropdown key={group.label} group={group} pathname={pathname} />
                ))}
            </SidebarMenu>
            {SETTINGS_NAV.filter((g) => !g.collapsible).map((group) => (
                <SidebarGroup key={group.label} className="px-0">
                    <SidebarGroupLabel className="text-[10px] font-semibold tracking-wide text-sidebar-foreground/50">
                        {group.label}
                    </SidebarGroupLabel>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {group.items.map((item) => (
                                <SidebarMenuItem key={item.to}>
                                    <SidebarMenuButton
                                        asChild
                                        isActive={pathname === item.to}
                                        className={NAV_BUTTON_CLASS}
                                    >
                                        <Link to={item.to}>
                                            <item.icon className="size-2" />
                                            {item.label}
                                        </Link>
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            ))}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            ))}
        </>
    );
}

export function AppSidebar() {
    const { pathname } = useLocation();
    const inSettings = pathname.startsWith('/settings');
    const { runningHere } = useMeetings();

    return (
        <Sidebar
            className="[&_[data-sidebar=sidebar]]:m-0 [&_[data-sidebar=sidebar]]:rounded-none [&_[data-sidebar=sidebar]]:border-none [&_[data-sidebar=sidebar]]:bg-sidebar"
        >
            <SidebarHeader className="px-4 py-6 text-xs font-medium tracking-wide text-sidebar-foreground/70 hover:text-sidebar-accent-foreground">
                Interview-Assistant
            </SidebarHeader>
            <SidebarContent className="p-2">
                {inSettings ? (
                    <SettingsNav pathname={pathname} />
                ) : (
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <SidebarMenuButton
                                asChild
                                isActive={pathname === '/'}
                                className="rounded-lg text-[10px] font-semibold tracking-wide text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground"
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
                                isActive={pathname === '/meetings'}
                                className="rounded-lg text-[10px] font-semibold tracking-wide text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground"
                            >
                                <Link to="/meetings">
                                    <IconUsersGroup className="size-2" />
                                    Meetings
                                    {runningHere && (
                                        <span
                                            className="ml-auto size-1.5 animate-pulse rounded-full bg-emerald-500"
                                            title="A meeting is live"
                                        />
                                    )}
                                </Link>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                        <SidebarMenuItem>
                            <SidebarMenuButton
                                asChild
                                isActive={pathname === '/ai'}
                                className="rounded-lg text-[10px] font-semibold tracking-wide text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground"
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
                                className="rounded-lg text-[10px] font-semibold tracking-wide text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground"
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
                                isActive={inSettings}
                                className="rounded-lg text-[10px] font-semibold tracking-wide text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground"
                            >
                                <Link to="/settings">
                                    <IconSettings className="size-2" />
                                    Settings
                                </Link>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>
                )}
            </SidebarContent>
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
