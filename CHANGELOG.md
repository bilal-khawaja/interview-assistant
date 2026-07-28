# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2026-07-28

### Added
- **TanStack Router 1.170.18** - File-based routing, used instead of `react-router-dom`
  - `@tanstack/router-plugin` (Vite plugin) - auto-generates `src/routeTree.gen.ts` with code splitting
  - `@tanstack/react-router-devtools` - in-app route devtools
  - `src/routes/__root.tsx` - root layout with `<Outlet />`
  - `src/routes/index.tsx` - `/` route (moved from `src/App.tsx`)
  - `src/routes/about.tsx` - `/about` route, demonstrates `Link` navigation to/from `/`
- **TanStack Form 1.33.2** - Type-safe, headless form state management
- **Zod 4.4.3** - Schema validation, wired into TanStack Form via `validators.onChange`
- Demo signup form (name + email) on the `/` route showing TanStack Form + Zod validation together
- `@typescript/native-preview` (`tsgo`) - native Go TypeScript compiler binary for faster local type-checking

### Changed
- `src/App.tsx` renamed to `src/routes/index.tsx`
- `src/renderer.tsx` now creates a router (`createRouter`) from the generated route tree and renders `<RouterProvider>` instead of `<App />` directly
- `vite.renderer.config.ts` - added `tanstackRouter` plugin ahead of `react()`

### Fixed
- `tsconfig.json` - removed dead `baseUrl` option (TS7/tsgo rejects it: `TS5102`); `paths` already resolves aliases explicitly
- `tsconfig.json` - added `vite/client` to `types` so `.css` side-effect imports type-check

### Removed
- `typescript` package - superseded by `@typescript/native-preview` (`tsgo`) for type-checking

## [1.0.0] - 2026-07-28

### Added

#### Core Technologies
- **Electron 43.2.0** - Desktop app framework with security best practices
- **Vite 8.1.5** - Build tool with Rolldown bundler (Rust-based, 10-30x faster)
- **React 19.2** - Latest version with concurrent features and optimizations
- **TypeScript 7.0.2** - Go-based compiler with 8-12x faster type-checking
- **Tailwind CSS v4.3.3** - Latest utility-first CSS with optimized performance

#### UI & Components
- **shadcn/ui** - Complete component library integration (50+ components)
- **Radix UI primitives** - Accessible component foundations
- **lucide-react 1.27.0** - Beautiful icon library (1000+ icons)
- **class-variance-authority** - Type-safe component variants
- **clsx + tailwind-merge** - Intelligent className utilities
- **cnfast** - Fast className merging alternative

#### Features
- ⚡ Hot Module Replacement (HMR) for instant React updates
- 🔒 Context isolation and secure preload script setup
- 🎨 Dark/light mode CSS variables support
- 📝 Full TypeScript support across all processes
- 🏗️ Electron Forge for building and packaging
- 🪟 Squirrel.Windows installer with proper startup handling
- 🎯 Path aliases (@/*) for clean imports
- 📦 Component CLI for easy shadcn/ui component installation

#### Configuration Files
- `components.json` - shadcn/ui configuration
- `tsconfig.json` - TypeScript 7 configuration with path aliases
- `vite.*.config.ts` - Separate Vite configs for main, preload, and renderer
- `forge.config.ts` - Electron Forge with Fuses plugin
- `.gitignore` - Updated with IDE files and build artifacts

#### Documentation
- Comprehensive README with setup instructions
- Complete project structure documentation
- Security best practices documentation
- Component usage examples
- IPC communication guide

### Fixed
- Vite deprecation warning: replaced `inlineDynamicImports` with `codeSplitting: false`
- shadcn/ui CLI configuration for Electron projects
- Tailwind CSS v4 @apply directive compatibility
- Path alias resolution across all TypeScript files

### Removed
- ESLint and related packages (minimal boilerplate approach)
- Platform-specific Linux makers (DEB/RPM) - keeping Windows & macOS only
- `@electron-forge/plugin-auto-unpack-natives` - unnecessary for base setup
- `.vscode` directory (added to .gitignore instead)

### Security
- Context isolation enabled by default (`contextIsolation: true`)
- Node integration disabled in renderer (`nodeIntegration: false`)
- Secure IPC communication via contextBridge
- Electron Fuses configured for enhanced security:
  - RunAsNode: disabled
  - EnableCookieEncryption: enabled
  - OnlyLoadAppFromAsar: enabled
  - EnableEmbeddedAsarIntegrityValidation: enabled

### Performance
- **TypeScript 7 (Go)**: Native code with shared-memory parallelism
- **Vite 8 + Rolldown**: Unified Rust bundler
- **React 19.2**: Latest concurrent features
- **Combined**: Up to 10-30x faster full builds vs older toolchains

### Developer Experience
- Ultra-minimal boilerplate with zero bloat
- Full TypeScript 7 support with Go compiler
- shadcn/ui CLI working out of the box
- Clean project structure
- Comprehensive documentation
- Path aliases for better imports
- CSS variables for easy theming

## Release Information

This is the initial release of the boilerplate featuring:
- ⚡ The fastest build tools available in 2026
- 🎨 Complete UI component system
- 🔒 Security best practices
- 📝 Production-ready configuration
- 🚀 Ready for immediate use

---

**For detailed usage instructions, see README.md**
