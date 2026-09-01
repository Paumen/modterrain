export const BRIDGE_TAG = ' (bridge)';
export const markBridge = (name) => name + BRIDGE_TAG;
export const isBridge = (name) => name.endsWith(BRIDGE_TAG);
