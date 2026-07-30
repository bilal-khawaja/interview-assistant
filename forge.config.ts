import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'System Container',
    executableName: 'systemcontainer', // Task manager process name
    appBundleId: 'com.system.container',
    // Windows Metadata for Task Manager disguise
    win32metadata: {
      FileDescription: 'System Container',
      ProductName: 'System Container',
      InternalName: 'systemcontainer',
      OriginalFilename: 'systemcontainer.exe',
    },

    // macOS permissions and stealth mode
    extendInfo: {
      LSUIElement: true, // Hides app from macOS Dock & Cmd+Tab switcher
      LSMinimumSystemVersion: '14.2',
      NSMicrophoneUsageDescription: 'App requires microphone access for live speech processing.',
      NSScreenCaptureUsageDescription: 'App requires screen recording access.',
      NSAudioCaptureUsageDescription: 'App requires system audio capture access.',
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
