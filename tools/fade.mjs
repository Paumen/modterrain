export const FADE_TAG = ' (fade)';
export const markFade = (name) => name + FADE_TAG;
export const isFade = (name) => name.endsWith(FADE_TAG);
