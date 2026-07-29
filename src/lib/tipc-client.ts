import { createClient as createQueryClient } from '@egoist/tipc/react-query';
import { createClient as createInvokeClient, createEventHandlers } from '@egoist/tipc/renderer';
import type { AppRouter } from '../main';
import type { AiChatRendererHandlers } from '../ai/controllers/ai-chat.handlers';

/** react-query-backed client: `.useMutation()` / `.useQuery()` per procedure. */
export const tipcClient = createQueryClient<AppRouter>({ ipcInvoke: window.ipc.invoke });

/** Plain invoke client for use outside React hooks (e.g. `useRealtimeChat`'s `getToken`). */
export const tipcInvoker = createInvokeClient<AppRouter>({ ipcInvoke: window.ipc.invoke });

export const rendererHandlers = createEventHandlers<AiChatRendererHandlers>({
  on: window.ipc.on,
  send: window.ipc.send,
});
