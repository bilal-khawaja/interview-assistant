import { BrowserWindow } from 'electron';
import path from 'node:path';

// Loads the shared renderer bundle with a `dialog` search param; renderer.tsx
// reads it and mounts the matching dialog component. file:// pathname routing
// can't target a sub-route directly, so path-based TanStack routes don't work
// for these secondary windows.
function loadDialog(win: BrowserWindow, dialog: 'splash' | 'update' | 'upgrade', params: Record<string, string> = {}) {
  const search = new URLSearchParams({ dialog, ...params }).toString();

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}/?${search}`);
  } else {
    win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), { search });
  }
}

let mouseEventsIgnored = false;
let windowResizing = false;
let resizeAnimation: NodeJS.Timeout | null = null;
const RESIZE_ANIMATION_DURATION = 500;

// Stealth win dow title for the main window to avoid detection by users and system processes
const WINDOW_TITLE = 'systemcontainer';

function createSplashWindow() {

    const splashWindow = new BrowserWindow({
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
        backgroundColor: '#00000000',
    });

// Apply stealth modes

splashWindow.setContentProtection(true);
splashWindow.setVisibleOnAllWorkspaces(true,
     { visibleOnFullScreen: true });

// For windows
if (process.platform === 'win32') {
    try {
        splashWindow.setSkipTaskbar(true);
        splashWindow.setAlwaysOnTop(true, 'screen-saver', 1);
        console.log('Successfully hid the splash window from the taskbar.');
    } catch (error) {
        console.error('Failed to hide the splash window from the taskbar.', error);
    }
}

// For macOS
if (process.platform === 'darwin') {
    try {
        splashWindow.setHiddenInMissionControl(true);
        console.log('Successfully hid the splash window from Mission Control.');
    } catch (error) {
        console.error('Failed to hide the splash window from Mission Control.', error);
    }
}

loadDialog(splashWindow, 'splash');
return splashWindow;

}

function createUpdateWindow(releaseNotes: string) {


    const updateWindow = new BrowserWindow({
        width: 440,
        height: 550,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
        backgroundColor: '#00000000',
    });

    // Apply stealth modes
    updateWindow.setContentProtection(true);
    updateWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    if (process.platform === 'win32') {
    try {
        updateWindow.setSkipTaskbar(true);
        updateWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    } catch (error) {
        console.warn('Could not apply update window stealth modes:', error);
    }
}

    if (process.platform === 'darwin') {
        try {
        
            updateWindow.setHiddenInMissionControl(true);
        } catch (error) {
            console.warn('Could not hide update window from Mission Control:', error);
        }
    }

    loadDialog(updateWindow, 'update', { notes: releaseNotes });
    return updateWindow;
}


function createUpgradeWindow(previousVersion: string | null, currentVersion: string) {

    const upgradeWindow = new BrowserWindow({

        width: 440,
        height: 520,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
        backgroundColor: '#00000000',
    });

    // Apply stealth modes
    upgradeWindow.setContentProtection(true);
    upgradeWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Center window
    upgradeWindow.center();

    if (process.platform === 'win32') {
        try {
            upgradeWindow.setSkipTaskbar(true);
            upgradeWindow.setAlwaysOnTop(true, 'screen-saver', 1);
        } catch (error) {
            console.warn('Could not apply upgrade window stealth modes:', error);
        }
    }

    if (process.platform === 'darwin') {
        try {

        } catch (error) {
            console.warn('Could not hide upgrade window from Mission Control:', error);
        }
        
    }

    loadDialog(upgradeWindow, 'upgrade', {
        previousVersion: previousVersion ?? '',
        currentVersion,
    });
    return upgradeWindow;
}

export function awaitWindowClosed(win: BrowserWindow): Promise<void> {
    return new Promise((resolve) => win.once('closed', resolve));
}

export {
    createSplashWindow,
    createUpdateWindow,
    createUpgradeWindow,
};