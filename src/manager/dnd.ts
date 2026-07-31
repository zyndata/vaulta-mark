/**
 * Dragging bookmarks into folders.
 *
 * Small on purpose: a drop zone is four listeners that everybody gets wrong the same four ways, so
 * they are written once here and reused by the list's folder rows and by the sidebar's tree.
 *
 * **The drag carries ids and nothing else.** A drag can end anywhere — another tab, another
 * application, the desktop — and whatever is in the `DataTransfer` goes with it. A title or a URL
 * on the drag would be vault content leaving the vault by a route INV-6 never sees, so the payload
 * is a list of opaque item ids under a private MIME type, and no `text/plain` or `text/uri-list`
 * is offered at all. That also means a drag from outside cannot masquerade as one of ours: the type
 * is the whole test.
 *
 * The ids on the `DataTransfer` are deliberately *not* what the drop acts on — `dataTransfer` is
 * unreadable during `dragover`, which is exactly when a drop target has to decide whether it can
 * accept, so the manager keeps the dragged ids in its own state and this file only asks "is this
 * ours?". The payload is still set, because a drag with no data does not start in every browser.
 */

/** Private to this extension; the browser never surfaces it to a web page. */
export const DRAG_TYPE = 'application/x-vaultamark-items';

/** Class put on whatever a drop would land in. Styled in `manager.css`. */
const DROP_TARGET_CLASS = 'is-drop-target';

export function isItemDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(DRAG_TYPE) === true;
}

export interface DropZoneOptions {
  /** Whether this target can accept the drag in flight. Asked on every `dragover`. */
  readonly accepts: () => boolean;
  readonly onDrop: () => void;
}

/**
 * Make `element` a drop target.
 *
 * `dragover` must `preventDefault()` on *every* event to keep accepting the drag — the default
 * action of a drag over an element is "refuse it", so a target that only says yes once says no for
 * the rest of the gesture.
 *
 * Propagation stops at the innermost target that accepts: a folder inside a folder is two nested
 * elements, and without this both would light up and the outer one would take the drop.
 */
export function dropZone(element: HTMLElement, options: DropZoneOptions): void {
  const leave = (): void => {
    element.classList.remove(DROP_TARGET_CLASS);
  };

  element.addEventListener('dragover', (event: DragEvent) => {
    if (!isItemDrag(event) || !options.accepts()) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
    element.classList.add(DROP_TARGET_CLASS);
  });

  // `dragleave` fires when the pointer crosses into a *child* as well, which would flicker the
  // highlight off over any target that has one. `relatedTarget` is where the pointer went.
  element.addEventListener('dragleave', (event: DragEvent) => {
    const to = event.relatedTarget;
    if (to instanceof Node && element.contains(to)) return;
    leave();
  });

  element.addEventListener('drop', (event: DragEvent) => {
    if (!isItemDrag(event) || !options.accepts()) return;
    event.preventDefault();
    event.stopPropagation();
    leave();
    options.onDrop();
  });

  // A drag that ends anywhere else still has to clear this target's highlight.
  element.addEventListener('dragend', leave);
}

/** Put the dragged ids on the event. Returns false when the drag should not start. */
export function startItemDrag(event: DragEvent, ids: readonly string[]): boolean {
  if (ids.length === 0 || event.dataTransfer === null) return false;
  event.dataTransfer.setData(DRAG_TYPE, ids.join(' '));
  event.dataTransfer.effectAllowed = 'move';
  return true;
}
