import type { AuthState } from '../types/auth';

/**
 * Main -> renderer push events for the account.
 * Shared type between the main-process sender and the renderer listener.
 */
export type AuthRendererHandlers = {
  onAuthChanged: (data: AuthState) => void;
};
