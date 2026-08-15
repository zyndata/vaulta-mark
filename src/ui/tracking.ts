/**
 * "You just turned the tracking strip on — shall I clean what is already saved?"
 *
 * The setting only ever described what happens to the *next* thing vaulted, so switching it on left
 * every `?utm_source=` already in the vault exactly where it was. That is a reasonable default for a
 * setting and a strange one for a person: someone who has just said they do not want campaign
 * parameters in their bookmarks does not mean "from now on, and never mind the four hundred I
 * already have".
 *
 * Two rules make the offer worth making:
 *
 * - **It is only made when there is something to clean.** A dialog answering "0 bookmarks would
 *   change" is a dialog that taught the user to dismiss the next one unread, so the count is asked
 *   for first and nothing appears when it is zero.
 * - **It is only ever an offer.** Nothing is rewritten by the toggle itself. Rewriting a saved
 *   address is a change to the user's data, and it happens because they pressed the button that
 *   says so.
 *
 * Callbacks rather than `send` calls, like `incognito-prompt.ts`: this file has to be testable
 * without a service worker on the other end, and the popup and the manager wire the same two
 * messages to it.
 */

import { confirmDialog, dialogText } from './dialog.js';
import { msg } from './dom.js';

export interface TrackingCleanupDeps {
  /** How many saved bookmarks would change. `COUNT_TRACKING_PARAMS`. */
  readonly count: () => Promise<number>;
  /** Rewrite them, answering with how many changed. `STRIP_TRACKING_PARAMS`. */
  readonly strip: () => Promise<number>;
  /** Where the outcome is reported. The popup's notice line, the manager's live region. */
  readonly say: (text: string) => void;
}

/**
 * Offer the clean-up, and carry it out if it is accepted.
 *
 * Resolves once the question has been settled either way, so a caller can `void` it and let the
 * settings screen carry on repainting behind the dialog.
 */
export async function offerTrackingCleanup(deps: TrackingCleanupDeps): Promise<void> {
  const affected = await deps.count();
  if (affected <= 0) return;

  const confirmed = await confirmDialog({
    heading: msg('trackingCleanupHeading'),
    body: [
      dialogText(
        affected === 1 ? 'trackingCleanupBodyOne' : 'trackingCleanupBody',
        [String(affected)],
      ),
      dialogText('trackingCleanupCaveat'),
    ],
    confirmLabel: msg('trackingCleanupButton'),
  });
  if (!confirmed) return;

  const changed = await deps.strip();
  // Nothing changed means the strip failed and the caller has already said so, or another window
  // cleaned the vault while this dialog was open. Neither is worth "cleaned 0 bookmarks".
  if (changed <= 0) return;
  deps.say(
    changed === 1 ? msg('trackingCleanedOne') : msg('trackingCleaned', [String(changed)]),
  );
}
