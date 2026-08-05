/**
 * This file will automatically be loaded by vite and run in the "renderer" context.
 * Renderer process entry point for the Electron app.
 */

import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { SplashDialog } from './components/splash.dialogue';
import { UpdateDialog } from './components/update.dialogue';
import { PillToolbar } from './components/pill-toolbar';

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

// Secondary windows (splash/update/upgrade) load this same bundle with a
// `dialog` search param instead of a router path — file:// pathname routing
// can't target a sub-route directly, so path-based routes don't work for them.
const dialog = new URLSearchParams(window.location.search).get('dialog');

function Root() {
  if (dialog === 'splash') return <SplashDialog />;
  if (dialog === 'update') return <UpdateDialog />;
  if (dialog === 'pill') return <PillToolbar />;
  return <RouterProvider router={router} />;
}

createRoot(rootElement).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
