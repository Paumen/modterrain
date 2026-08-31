// Fences, railings and rope are drawn like everything else but kept in their
// own merged meshes, so the viewer's camera can pass through them: a camera
// that flinches at a waist-high fence you are looking over is worse than no
// collision at all.
//
// The merge step marks those meshes and the viewer reads the mark, so the two
// have to agree on it. They agree here.

export const SEE_THROUGH = ' (see through)';
export const markSeeThrough = (name) => name + SEE_THROUGH;
export const isSeeThrough = (name) => name.endsWith(SEE_THROUGH);
