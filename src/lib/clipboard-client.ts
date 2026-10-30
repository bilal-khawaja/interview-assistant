import { tipcInvoker } from './tipc-client';

/**
 * Copies text to the system clipboard. The main process does it, because the window's own
 * clipboard API is refused by the permission handler that only allows the microphone. Falls
 * back to the web API, then to a selection copy, if the main process cannot (for example an
 * old main process that has not been restarted). True when something worked.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
    try {
        await tipcInvoker.window.copyText({ text });
        return true;
    } catch {
        // fall through to the web API
    }
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // fall through to the oldest way
    }
    return copyWithSelection(text);
}

/** Selects the text in a hidden field and runs the browser's copy command, which needs no permission. */
function copyWithSelection(text: string): boolean {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
        field.select();
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        field.remove();
        previous?.focus();
    }
}
