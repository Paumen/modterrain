/* Touch gestures.
 *
 * Three gestures share one surface, and a tap is just a drag that never went
 * anywhere, so they have to be told apart rather than handled independently.
 *
 *   - nothing has happened yet          -> pending
 *   - moved further than SLOP           -> orbit or zoom, whichever axis led
 *   - released still pending, in time   -> tap
 *
 * The axis is chosen once, when the finger first crosses SLOP, and then held
 * for the rest of the gesture. Re-deciding every frame is what makes a camera
 * feel like it is arguing with you: a drag that curves slightly would flicker
 * between orbiting and zooming. Locking it means a gesture that starts sideways
 * stays an orbit even as your thumb arcs.
 *
 * Only the first finger down is tracked. There is no pinch here by design, so
 * a second finger is ignored outright rather than half-handled.
 */

const SLOP = 10;      // CSS pixels of travel before a press becomes a drag
const TAP_MS = 300;   // longer than this and a still finger is a hold, not a tap
const WHEEL_SCALE = 0.5;

export function attachInput(element, { onTap, onOrbit, onZoom }) {
  let pointer = null;

  const reset = () => { pointer = null; };

  element.addEventListener('pointerdown', (event) => {
    if (pointer !== null) return; // already tracking a finger
    pointer = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      startedAt: performance.now(),
      mode: 'pending',
    };
    element.setPointerCapture(event.pointerId);
  });

  element.addEventListener('pointermove', (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;

    const dx = event.clientX - pointer.lastX;
    const dy = event.clientY - pointer.lastY;

    if (pointer.mode === 'pending') {
      const totalX = event.clientX - pointer.startX;
      const totalY = event.clientY - pointer.startY;
      if (Math.hypot(totalX, totalY) < SLOP) return;
      pointer.mode = Math.abs(totalX) >= Math.abs(totalY) ? 'orbit' : 'zoom';
    }

    if (pointer.mode === 'orbit') onOrbit?.(dx);
    else onZoom?.(dy);

    pointer.lastX = event.clientX;
    pointer.lastY = event.clientY;
  });

  const release = (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    const tapped = pointer.mode === 'pending'
      && performance.now() - pointer.startedAt <= TAP_MS
      && Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) < SLOP;
    reset();
    if (tapped && event.type === 'pointerup') onTap?.(event.clientX, event.clientY);
  };

  element.addEventListener('pointerup', release);
  element.addEventListener('pointercancel', release);

  // Not part of the touch story, but it makes the page usable on a desktop.
  element.addEventListener('wheel', (event) => {
    event.preventDefault();
    onZoom?.(-event.deltaY * WHEEL_SCALE);
  }, { passive: false });

  element.addEventListener('contextmenu', (event) => event.preventDefault());

  return { reset };
}
