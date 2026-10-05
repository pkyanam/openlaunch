// Larger host capabilities do not widen microcontroller contracts.
export const deviceFunctionLimit = (kind: string) =>
  kind === "linux" ? 24 : 16;
export const DESKTOP_RESULT_BYTES = 48 * 1024;
export const isDesktopScreenshot = (kind: string, capability: string) =>
  kind === "linux" && capability === "desktop.screenshot";
