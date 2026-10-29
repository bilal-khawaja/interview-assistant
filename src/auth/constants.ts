/**
 * The origin the app presents on sign-in and sign-up. The main process has no web origin,
 * so it sends this explicitly; the backend lists it in AUTH_TRUSTED_ORIGINS.
 */
export const APP_ORIGIN = 'interview-assistant://app';
