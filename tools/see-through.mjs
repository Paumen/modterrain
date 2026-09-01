export const SEE_THROUGH_PIECES = /^(Docks_|Path_Fence_|Prop_|Tiered_Retaining_Wall_)/;
export const SEE_THROUGH_TILE = 4;
export const SEE_THROUGH = ' (see through)';
export const markSeeThrough = (name) => name + SEE_THROUGH;
export const isSeeThrough = (name) => name.endsWith(SEE_THROUGH);
