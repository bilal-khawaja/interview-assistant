import { getRendererHandlers, tipc } from '@egoist/tipc/main';
import type { WebContents } from 'electron';
import type { AuthState, SignInInput, SignUpInput } from '../types/auth';
import type { ApiResult } from '../types/transcript';
import { BackendApiError } from '../transcript/services/backend-api.client';
import type { AuthService } from './auth.service';
import type { AuthRendererHandlers } from './auth.handlers';

const t = tipc.create();

function failure(error: unknown): { error: string; status?: number } {
  if (error instanceof BackendApiError) {
    return { error: error.message, ...(error.status !== null ? { status: error.status } : {}) };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

/** Everything here returns the account state, never the token. */
export function createAuthRouter(service: AuthService) {
  // Each window that calls in is told when the signed-in state changes, once.
  const attached = new Map<number, () => void>();
  const attach = (sender: WebContents) => {
    if (attached.has(sender.id)) return;
    const handlers = getRendererHandlers<AuthRendererHandlers>(sender);
    const detach = service.onChange((state) => {
      if (!sender.isDestroyed()) handlers.onAuthChanged.send(state);
    });
    attached.set(sender.id, detach);
    sender.once('destroyed', () => {
      detach();
      attached.delete(sender.id);
    });
  };

  return t.router({
    /** The current state; checks the saved session first if that has not happened yet. */
    authState: t.procedure.action(async ({ context }): Promise<AuthState> => {
      attach(context.sender);
      return service.current.status === 'unknown' ? service.restore() : service.current;
    }),

    /** Checks the saved session again, e.g. after the backend was unreachable. */
    authRestore: t.procedure.action(async ({ context }): Promise<AuthState> => {
      attach(context.sender);
      return service.restore();
    }),

    authSignIn: t.procedure
      .input<SignInInput>()
      .action(async ({ input, context }): Promise<ApiResult<{ state: AuthState }>> => {
        attach(context.sender);
        try {
          return { state: await service.signIn(input) };
        } catch (error) {
          return failure(error);
        }
      }),

    authSignUp: t.procedure
      .input<SignUpInput>()
      .action(async ({ input, context }): Promise<ApiResult<{ state: AuthState }>> => {
        attach(context.sender);
        try {
          return { state: await service.signUp(input) };
        } catch (error) {
          return failure(error);
        }
      }),

    authSignOut: t.procedure.action(async (): Promise<AuthState> => service.signOut()),
  });
}
