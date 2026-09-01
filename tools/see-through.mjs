export const SEE_THROUGH_PIECES = /^(Docks_|Path_Fence_|Prop_|Tiered_Retaining_Wall_)/;
export const FADE_PIECES = /^(Docks_|Prop_Bridge_Rope_)/;

const SEE_THROUGH = ' (see through)';
const FADES = ' (see through, fades)';

export const markSeeThrough = (name, fades) => name + (fades ? FADES : SEE_THROUGH);
export const isSeeThrough = (name) => name.endsWith(SEE_THROUGH) || name.endsWith(FADES);
export const isFading = (name) => name.endsWith(FADES);
