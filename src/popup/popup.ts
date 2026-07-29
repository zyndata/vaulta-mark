import './popup.css';

import type { PingRequest, Response } from '../shared/messages';

/** Every user-facing string lives in `_locales/en/messages.json`; the markup only names them. */
function localize(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = element.dataset['i18n'];
    if (key !== undefined) element.textContent = chrome.i18n.getMessage(key);
  }
}

async function showWorkerStatus(): Promise<void> {
  const status = document.getElementById('vm-status');
  if (status === null) return;

  const ping: PingRequest = { type: 'PING' };
  let alive = false;
  try {
    const response: Response | undefined = await chrome.runtime.sendMessage(ping);
    alive = response?.type === 'PONG';
  } catch {
    // A terminated worker that fails to restart is the only way this rejects, and it is exactly
    // what the status line is here to report.
    alive = false;
  }

  status.textContent = chrome.i18n.getMessage(
    alive ? 'popupWorkerReady' : 'popupWorkerUnreachable',
  );
}

localize(document);

const version = document.getElementById('vm-version');
if (version !== null) {
  version.textContent = chrome.i18n.getMessage('popupVersion', [
    chrome.runtime.getManifest().version,
  ]);
}

void showWorkerStatus();
