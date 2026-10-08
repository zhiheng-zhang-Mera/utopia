// KEEPING A SURFACE USABLE WHILE THE CITY KEEPS TALKING.
//
// `app.js` re-renders the current page from `refresh()`, and `refresh()` runs every four seconds AND on every event the
// City pushes over the WebSocket. A view that rebuilds `root.innerHTML` therefore rebuilds it constantly - and anything
// the DOM was holding on the owner's behalf is lost: an open `<details>` snaps shut, focus leaves the field being typed
// into, and the caret goes with it. Measured, not theoretical: this is what made an owner's Danger Zone collapse
// mid-typing, and it is what made browser tests fail "element is not visible" under load, where the four-second tick was
// more likely to land in the middle of a run.
//
// A form the owner cannot finish typing into is not a form. These three helpers are what a view needs to survive being
// re-rendered: remember which field had focus and where the caret was, put them back afterwards, and carry a
// `<details>` open state in the view's own state rather than in DOM attributes that a re-render throws away.
export function captureFocus(root, documentRef = globalThis.document) {
  const active = documentRef?.activeElement;
  // Only the view's OWN fields are captured: a re-render must never steal focus back from somewhere else on the page.
  if (!active || !root.contains(active) || !active.id) return null;
  let selectionStart = null, selectionEnd = null;
  try { selectionStart = active.selectionStart; selectionEnd = active.selectionEnd; } catch { /* not a text field */ }
  return {id: active.id, selectionStart, selectionEnd};
}

export function restoreFocus(root, captured) {
  if (!captured) return;
  const field = root.querySelector('#' + captured.id);
  if (!field || typeof field.focus !== 'function') return;
  field.focus();
  // The caret is restored only for fields that really had one, and only if the field is still a text field: setting a
  // selection on a control that has none throws, and swallowing that silently would hide a genuine mistake.
  if (captured.selectionStart === null || typeof field.setSelectionRange !== 'function') return;
  try { field.setSelectionRange(captured.selectionStart, captured.selectionEnd ?? captured.selectionStart); } catch { /* not selectable */ }
}

/**
 * The `open` attribute for a `<details>` the view owns, taken from view state so a re-render cannot close it.
 * Usage: keep the boolean in the view's state, emit this attribute in the template, and set it from the `toggle` event.
 */
export const detailsOpen = (state, key) => (state?.[key] === true ? ' open' : '');
