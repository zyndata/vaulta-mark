/**
 * The history-cleanup panel's three messages, wired once.
 *
 * `ui/history-cleanup.ts` takes callbacks rather than sending messages itself, so that it tests
 * without a service worker on the other end (the same shape as `ui/tracking.ts`). This is the file
 * that supplies them — and it is a file of its own rather than a function inside either screen,
 * because **two** screens mount that panel: onboarding step 5 and Settings → Privacy. A tool that
 * deletes browsing history and reported different numbers depending on which screen it was opened
 * from would be two tools sharing a name.
 */

import { requestHistoryPermission } from '../history/cleanup.js';
import { send } from '../shared/messages.js';
import { errorText } from '../ui/strings.js';
import type { CleanupPreview } from '../ui/history-cleanup.js';

export interface HistoryMessages {
  readonly request: () => Promise<boolean>;
  readonly preview: () => Promise<CleanupPreview | null>;
  readonly clear: () => Promise<number | null>;
}

/**
 * @param say where a failure is reported — the manager's live region, or the flow's status line.
 *   Failures are announced *there* rather than returned, because the panel's own answer for both is
 *   "nothing was deleted", and the reason belongs beside the rest of the page's news.
 */
export function historyDeps(say: (text: string, kind?: 'info' | 'danger') => void): HistoryMessages {
  return {
    request: requestHistoryPermission,
    preview: async () => {
      const response = await send({ type: 'PREVIEW_HISTORY_CLEANUP' });
      if (response.type === 'ERROR') {
        say(errorText(response.code), 'danger');
        return null;
      }
      return response;
    },
    clear: async () => {
      const response = await send({ type: 'CLEAR_VAULTED_HISTORY' });
      if (response.type === 'ERROR') {
        say(errorText(response.code), 'danger');
        return null;
      }
      return response.count;
    },
  };
}
