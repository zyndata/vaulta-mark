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

/* ------------------------------------------------------------------ reordering (Phase 12) */

/** Where a drop on a row would put the dragged items, relative to that row. */
export type DropPlacement = 'before' | 'after' | 'into';

/** Classes for the insertion line and the "into" highlight. Styled in `manager.css`. */
const PLACEMENT_CLASSES = ['is-drop-before', 'is-drop-after', DROP_TARGET_CLASS];

export interface ReorderZoneOptions {
  /**
   * Which placements this row can take right now.
   *
   * `into` is a folder that would accept the drag; `before`/`after` are a position among siblings,
   * and they are offered only where a position is a thing the user can see — the manual sort order,
   * in a plain folder listing. Under "newest first" a drop between two rows is a gesture with no
   * effect and no explanation, so those rows offer `into` and nothing else.
   */
  readonly placements: () => readonly DropPlacement[];
  readonly onDrop: (placement: DropPlacement) => void;
}

/**
 * Make `element` a drop target that distinguishes "into this" from "between these two".
 *
 * The row is read in three bands: the top and bottom quarters mean before and after, and the middle
 * half means into. When `into` is not on offer the row splits in half instead, so every pixel of it
 * still answers something — a dead band in the middle of a row is a drag that mysteriously refuses
 * over half its target.
 *
 * Separate from {@link dropZone} rather than an option on it, because the two differ in the thing
 * that is hard: this one recomputes on *every* `dragover` (the pointer moves within one element and
 * the answer changes), where a plain drop zone decides once on entry.
 */
export function reorderZone(element: HTMLElement, options: ReorderZoneOptions): void {
  let current: DropPlacement | null = null;

  const clear = (): void => {
    element.classList.remove(...PLACEMENT_CLASSES);
    current = null;
  };

  const placementAt = (event: DragEvent): DropPlacement | null => {
    const allowed = options.placements();
    if (allowed.length === 0) return null;
    const box = element.getBoundingClientRect();
    if (box.height === 0) return null;
    const fraction = (event.clientY - box.top) / box.height;

    if (allowed.includes('into')) {
      if (fraction < 0.25 && allowed.includes('before')) return 'before';
      if (fraction > 0.75 && allowed.includes('after')) return 'after';
      return 'into';
    }
    if (!allowed.includes('before')) return allowed.includes('after') ? 'after' : null;
    if (!allowed.includes('after')) return 'before';
    return fraction < 0.5 ? 'before' : 'after';
  };

  element.addEventListener('dragover', (event: DragEvent) => {
    if (!isItemDrag(event)) return;
    const placement = placementAt(event);
    if (placement === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
    if (placement === current) return;
    element.classList.remove(...PLACEMENT_CLASSES);
    element.classList.add(
      placement === 'into' ? DROP_TARGET_CLASS : `is-drop-${placement}`,
    );
    current = placement;
  });

  element.addEventListener('dragleave', (event: DragEvent) => {
    const to = event.relatedTarget;
    if (to instanceof Node && element.contains(to)) return;
    clear();
  });

  element.addEventListener('drop', (event: DragEvent) => {
    if (!isItemDrag(event)) return;
    const placement = placementAt(event);
    if (placement === null) return;
    event.preventDefault();
    event.stopPropagation();
    clear();
    options.onDrop(placement);
  });

  element.addEventListener('dragend', clear);
}
