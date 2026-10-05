/** A bounded image source from a final screenshot receipt, never arbitrary HTML. */
export function screenshotSource(receipt: any): string | undefined {
  const value = receipt?.result;
  if (
    receipt?.capability !== "desktop.screenshot" ||
    receipt?.status !== "succeeded" ||
    value?.mimeType !== "image/jpeg" ||
    typeof value.imageBase64 !== "string" ||
    value.imageBase64.length === 0 ||
    value.imageBase64.length > 43692 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.imageBase64,
    )
  )
    return;
  return "data:image/jpeg;base64," + value.imageBase64;
}
