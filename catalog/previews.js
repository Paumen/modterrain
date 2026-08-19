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
  box.replaceChildren(viewer);
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
