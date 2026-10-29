import { useSyncExternalStore } from 'react';
import { AuthStore, type AuthApi, type AuthViewState } from './auth-store';
import { authHandlers, tipcInvoker } from './tipc-client';

const t = tipcInvoker.auth;

const api: AuthApi = {
  state: () => t.authState(),
  restore: () => t.authRestore(),
  signIn: (input) => t.authSignIn(input),
  signUp: (input) => t.authSignUp(input),
  signOut: () => t.authSignOut(),
  listen: (handler) => authHandlers.onAuthChanged.listen(handler),
};

/** The one auth store for this window. */
export const authStore = new AuthStore(api);

export function useAuth(): AuthViewState {
  return useSyncExternalStore(authStore.subscribe, authStore.getState);
}
