/**
 * A one-shot handoff for "open Settings and land on this section". Tab
 * switches remount the destination panel (App renders one tab at a time), so
 * the sender cannot scroll to an element that does not exist yet. The sender
 * records the wish here, dispatches the tab change, and the destination
 * consumes it after it has mounted.
 */

let pending: string | null = null;

export function requestSectionJump(id: string): void {
  pending = id;
}

/** Returns the requested section id once, then forgets it. */
export function consumeSectionJump(): string | null {
  const id = pending;
  pending = null;
  return id;
}
