type ClipboardWriter = Pick<Clipboard, "writeText">;

/**
 * Copy sensitive setup material without assuming that Clipboard API access is
 * available. Browsers may deny it outside a secure context or after the user
 * changes permissions.
 */
export async function copyTextToClipboard(
  value: string,
  clipboard: ClipboardWriter | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> {
  if (!clipboard?.writeText) return false;

  try {
    await clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
