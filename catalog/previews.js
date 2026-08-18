/* Lazy 3D previews, shared by the catalog grid and the builder's piece list.
 * A viewer is attached only while its tile is near the viewport and, on the
 * way out, leaves behind a still of itself so scrolling back is instant. */

const observer = new IntersectionObserver(
  (entries) => {
    for (const { target, isIntersecting } of entries) {
      if (isIntersecting) attachViewer(target);
      else detachViewer(target);
    }
  },
  { rootMargin: '800px 0px' },
);

function attachViewer(box) {
  if (box.querySelector('model-viewer')) return;

  const viewer = document.createElement('model-viewer');
  viewer.src = box.dataset.src;
  viewer.alt = box.dataset.alt;
  viewer.setAttribute('camera-orbit', '35deg 68deg auto');
  viewer.setAttribute('environment-image', 'neutral');
  viewer.setAttribute('shadow-intensity', '0.6');
  viewer.setAttribute('shadow-softness', '0.9');
  viewer.setAttribute('interaction-prompt', 'none');
  viewer.setAttribute('disable-zoom', '');
  viewer.setAttribute('loading', 'eager');
  if (box.dataset.floorSrc) {
    viewer.addEventListener('load', () => swapToFloor(viewer, box.dataset.floorSrc), { once: true });
  }
  box.replaceChildren(viewer);
}

// The floored file's own "auto" camera-orbit fits the whole scene, floor
// included, which zooms out and shrinks the model — the floor is padded
// past the model's footprint and sits off-center (at its base), so even
// tight padding inflates the bounding sphere. Loading the plain model first
// and locking its real auto-resolved framing (camera-orbit's radius is in
// the same units either way) onto the floored swap keeps the model exactly
// as prominent as everywhere else, with the floor just extending into frame.
export function swapToFloor(viewer, floorSrc) {
  const { theta, phi, radius } = viewer.getCameraOrbit();
  viewer.setAttribute('field-of-view', `${viewer.getFieldOfView()}deg`);
  viewer.setAttribute('camera-orbit', `${theta}rad ${phi}rad ${radius}m`);
  viewer.src = floorSrc;
}

function detachViewer(box) {
  const viewer = box.querySelector('model-viewer');
  if (!viewer) return;

  if (viewer.loaded && !box.dataset.snapshot) {
    try {
      box.dataset.snapshot = viewer.toDataURL('image/webp', 0.72);
    } catch {}
  }

  if (box.dataset.snapshot) {
    const image = document.createElement('img');
    image.src = box.dataset.snapshot;
    image.alt = box.dataset.alt;
    image.loading = 'lazy';
    box.replaceChildren(image);
  } else {
    box.replaceChildren();
  }
}

export const observe = (box) => observer.observe(box);
export const unobserve = (box) => observer.unobserve(box);
