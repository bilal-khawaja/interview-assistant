# Electron + Vite + React + shadcn/ui Boilerplate

A modern, ultra-fast Electron application boilerplate built with the latest bleeding-edge technologies. Perfect for building beautiful desktop applications with maximum performance.

## 🚀 Tech Stack

- **[Electron](https://electronjs.org/)** 43.2.0 - Desktop app framework
- **[Vite](https://vite.dev/)** 8.1.5 - Build tool with Rolldown bundler (10-30x faster)
- **[React](https://react.dev/)** 19.2 - Latest UI library with concurrent features
- **[TypeScript](https://www.typescriptlang.org/)** 7.0 - **Go-based compiler (8-12x faster builds!)**
- **[Tailwind CSS](https://tailwindcss.com/)** v4.3 - Latest utility-first CSS framework
- **[shadcn/ui](https://ui.shadcn.com/)** - Beautiful, accessible component library
- **[TanStack Router](https://tanstack.com/router)** - Type-safe, file-based routing (used instead of `react-router-dom`)
- **[TanStack Form](https://tanstack.com/form)** - Type-safe, headless form state management
- **[Zod](https://zod.dev/)** - TypeScript-first schema validation, used for form validation
- **[TanStack AI](https://tanstack.com/ai)** - Provider-agnostic AI SDK; OpenAI chat streamed from the Electron main process to the renderer via IPC

## ⚡ Performance

This boilerplate combines the fastest tools available in 2026:

- **Vite 8 + Rolldown**: Rust-based bundler replacing esbuild + Rollup
- **TypeScript 7**: Go rewrite with native code speed and multi-threading
- **React 19.2**: Latest concurrent features and optimizations
- **Tailwind CSS v4**: Optimized CSS engine with @import syntax
- **Combined**: Up to 10-30x faster full builds compared to older toolchains

## 📦 Features

- ⚡ **Blazing Fast HMR** - Instant React component updates
- 🦀 **Rolldown** - Rust-based bundler for production builds
- 🐹 **TypeScript 7 (Go)** - Native compiler with 8-12x faster type-checking
- 🎨 **Tailwind CSS v4** - Latest utility-first CSS with native performance
- 🧩 **shadcn/ui** - 50+ beautiful, accessible components ready to use
- 🧭 **TanStack Router** - File-based routing with full type safety
- 📋 **TanStack Form + Zod** - Type-safe forms with schema validation
- 🤖 **TanStack AI** - Streaming OpenAI chat, API key + prompt entered at runtime, no server needed
- 🔒 **Secure by Default** - Context isolation enabled, node integration disabled
- 📝 **Full Type Safety** - Across main and renderer processes
- 🏗️ **Production Ready** - Optimized build with Electron Forge
- 🪟 **Windows Squirrel** - Proper installation/update handling
- 🎯 **Path Aliases** - Clean imports with @/ prefix

## 🛠️ Getting Started

### Prerequisites

- Node.js (v18 or higher)
- npm, yarn, or pnpm

### Installation

```bash
# Clone the repository
git clone <your-repo-url> my-electron-app
cd my-electron-app

# Install dependencies
npm install
```

### Development

```bash
npm start
```

This launches the Electron app with HMR enabled.

### Build

```bash
# Package the app
npm run package

# Create distributables
npm run make
```

Creates platform-specific installers:
- **Windows**: Squirrel installer with auto-update support
- **macOS**: ZIP archive

## 📁 Project Structure

```
├── src/
│   ├── main.ts              # Electron main process
│   ├── preload.ts           # Preload script for secure IPC
│   ├── renderer.tsx         # React entry point, mounts RouterProvider
│   ├── routeTree.gen.ts     # Auto-generated route tree (TanStack Router)
│   ├── routes/
│   │   ├── __root.tsx       # Root layout (Outlet + Router Devtools)
│   │   ├── index.tsx        # `/` route - tech stack cards + TanStack Form + Zod demo
│   │   ├── about.tsx        # `/about` route - demonstrates Link navigation
│   │   └── ai.tsx           # `/ai` route - TanStack AI streaming OpenAI chat demo
│   ├── index.css            # Tailwind CSS v4 imports & theme
│   ├── lib/
│   │   └── utils.ts         # Utility functions (cn helper)
│   ├── components/
│   │   └── ui/              # shadcn/ui components
│   └── electron.d.ts        # TypeScript definitions for Electron API
├── components.json          # shadcn/ui configuration
├── index.html               # HTML template
├── package.json
├── tsconfig.json            # TypeScript 7 configuration
├── forge.config.ts          # Electron Forge configuration
├── vite.main.config.ts      # Vite config for main process
├── vite.preload.config.ts   # Vite config for preload script
└── vite.renderer.config.ts  # Vite config for renderer
```

## 🎨 UI Components

### shadcn/ui Integration

Add any component from the shadcn/ui library:

```bash
npx shadcn@latest add button
npx shadcn@latest add card
npx shadcn@latest add dialog
npx shadcn@latest add input
npx shadcn@latest add table
```

Components are added to `src/components/ui` and are fully customizable.

### Using Components

```tsx
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function MyComponent() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>My Card</CardTitle>
      </CardHeader>
      <CardContent>
        <Button>Click me</Button>
      </CardContent>
    </Card>
  );
}
```

### Available Component Categories

- **Layout**: Button, Card, Dialog, Sheet, Tabs, Accordion
- **Forms**: Input, Label, Select, Checkbox, Radio, Switch, Slider
- **Navigation**: Navigation Menu, Breadcrumb, Pagination
- **Feedback**: Alert, Toast, Progress, Skeleton
- **Data Display**: Table, Avatar, Badge, Separator, Calendar
- **Overlays**: Popover, Tooltip, Hover Card, Context Menu

## 🧭 Routing (TanStack Router)

File-based routing — used instead of `react-router-dom`. Every file in `src/routes/` becomes a route; the tree is auto-generated into `src/routeTree.gen.ts` on dev/build (do not edit that file by hand).

```tsx
// src/routes/about.tsx
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/about')({
  component: () => <div>About page</div>,
});
```

`src/routes/__root.tsx` is the shared layout (renders `<Outlet />` + Router Devtools). Add a new page by adding a new file under `src/routes/`.

Working example: the `/` route has a "TanStack Router" card with a `Link` to `/about`; `/about` links back with `Link to="/"`.

## 📋 Forms (TanStack Form + Zod)

Type-safe form state via `@tanstack/react-form`, validated with `zod` schemas. See the working example in `src/routes/index.tsx`.

```tsx
import { useForm } from '@tanstack/react-form';
import { z } from 'zod';

const schema = z.object({
  email: z.email(),
});

const form = useForm({
  defaultValues: { email: '' },
  validators: { onChange: schema },
  onSubmit: ({ value }) => console.log(value),
});
```

## 🤖 AI Chat (TanStack AI)

Visit `/ai` for a working OpenAI chat demo built on [`@tanstack/ai`](https://tanstack.com/ai/latest/docs/getting-started/overview) + `@tanstack/ai-openai`. shadcn `Select` (model), `Input` (API key), `Textarea` (prompt/output), and `Switch` (streaming toggle) — API key is session-only state, never persisted to disk.

Because `@tanstack/ai`'s `openaiText()` factory only reads the key from `OPENAI_API_KEY`, and this boilerplate takes the key from a runtime input instead, the key is sent over IPC to the Electron **main** process, where `createOpenaiChat(model, apiKey)` builds the adapter and `chat()` runs — the key never touches a network call from the renderer or gets bundled into any request the renderer can see.

```typescript
// src/main.ts (simplified)
import { chat } from '@tanstack/ai';
import { createOpenaiChat } from '@tanstack/ai-openai';

ipcMain.handle('ai:chat', async (event, req) => {
  const adapter = createOpenaiChat(req.model, req.apiKey);
  const messages = [{ role: 'user', content: req.prompt }];

  if (!req.stream) {
    return { text: await chat({ adapter, messages, stream: false }) };
  }

  for await (const chunk of chat({ adapter, messages, stream: true })) {
    if (chunk.type === 'TEXT_MESSAGE_CONTENT') {
      event.sender.send('ai:chunk', { id: req.id, delta: chunk.delta });
    }
  }
  event.sender.send('ai:done', { id: req.id });
});
```

Renderer side calls `window.electron.aiChat(...)` (exposed via `src/preload.ts`) and listens for `ai:chunk` / `ai:done` / `ai:error` events to build up the streamed output — see `src/routes/ai.tsx`.

Supported models (from `@tanstack/ai-openai`'s real model list): `gpt-5.2`, `gpt-5.2-pro`, `gpt-5.1`, `gpt-5`, `gpt-5-mini`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-4o`, `gpt-4o-mini`.

## 🔧 Configuration

### Main Process Security

Security best practices enabled by default:

- `contextIsolation: true` - Isolates preload scripts from renderer
- `nodeIntegration: false` - No Node.js access from renderer process
- Secure IPC via preload script

### IPC Communication

Use the preload script (`src/preload.ts`) to expose safe APIs:

```typescript
// src/preload.ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  ping: () => ipcRenderer.invoke('ping')
});

// src/electron.d.ts (add types)
export interface ElectronAPI {
  ping: () => Promise<string>;
}

// Usage in renderer
window.electron.ping();
```

### Tailwind CSS Customization

Edit `src/index.css` to customize theme colors and variables:

```css
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --radius: 0.625rem;
  /* ... more variables */
}
```

## 🎯 Why These Tools?

### TypeScript 7.0 (Go)
- Released July 2026
- 8-12x faster than TypeScript 6.0
- Native binary with shared-memory parallelism
- Identical type-checking semantics

### Vite 8 with Rolldown
- Released March 2026  
- Single unified bundler replacing esbuild + Rollup
- 10-30x faster production builds
- Full plugin compatibility

### React 19.2
- Latest stable version
- Modern concurrent features
- Automatic batching improvements
- Enhanced performance

### Tailwind CSS v4
- Native CSS import with `@import "tailwindcss"`
- Zero-config with Vite plugin
- CSS variables for theming
- Optimized performance

### shadcn/ui
- 50+ accessible components
- Built on Radix UI primitives
- Fully customizable source code
- Copy-paste philosophy

## 📝 Scripts

- `npm start` - Start development server
- `npm run package` - Package the app
- `npm run make` - Create installers

## 🚀 Building for Production

### Package the App

```bash
npm run package
```

### Create Distributables

```bash
npm run make
```

This creates platform-specific installers in the `out/` directory:
- **Windows**: `.exe` Squirrel installer
- **macOS**: `.zip` archive

## 🔒 Security Notes

This boilerplate follows Electron security best practices:

- Context isolation enabled
- Node integration disabled in renderer
- No remote module usage
- Secure IPC through preload scripts
- Content Security Policy ready

## 🛠️ Development Tips

- **Hot Reload**: Development server supports instant HMR
- **TypeScript**: Full type safety across all processes
- **Component Library**: Leverage shadcn/ui for consistent UI
- **Path Aliases**: Use `@/` imports for cleaner code
- **CSS Variables**: Use theme variables for consistent styling

## 📚 Learn More

- [Electron Documentation](https://www.electronjs.org/docs)
- [TypeScript 7.0 Announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [Vite 8 with Rolldown](https://vite.dev/blog/announcing-vite8)
- [React 19 Documentation](https://react.dev/)
- [shadcn/ui Documentation](https://ui.shadcn.com/)
- [Tailwind CSS v4](https://tailwindcss.com/)
- [Electron Forge](https://www.electronforge.io/)
- [TanStack Router](https://tanstack.com/router/latest)
- [TanStack Form](https://tanstack.com/form/latest)
- [TanStack AI](https://tanstack.com/ai/latest)
- [Zod](https://zod.dev/)

## 📄 License

MIT

---

**Built with ❤️ using the fastest tools in 2026**
