/** Intune app icon — stored in Git beside config.json, applied at deploy via Graph largeIcon/smallIcon. */

export const APP_ICON_ACCEPT = 'image/png,image/jpeg';
export const APP_ICON_MAX_BYTES = 512 * 1024;

export type AppIconUpload = { fileName: string; contentBase64: string };

export function iconFileNameForMime(mime: string): string | null {
  if (mime === 'image/png') return 'icon.png';
  if (mime === 'image/jpeg') return 'icon.jpg';
  return null;
}

export function validateAppIconFile(file: File): string | null {
  if (!file.type.startsWith('image/')) return 'Choose a PNG or JPEG image.';
  const name = iconFileNameForMime(file.type);
  if (!name) return 'Only PNG and JPEG icons are supported.';
  if (file.size > APP_ICON_MAX_BYTES) return `Icon must be ${APP_ICON_MAX_BYTES / 1024} KB or smaller.`;
  return null;
}

export async function readAppIconUpload(file: File): Promise<AppIconUpload> {
  const err = validateAppIconFile(file);
  if (err) throw new Error(err);
  const fileName = iconFileNameForMime(file.type)!;
  const buffer = await file.arrayBuffer();
  return {
    fileName,
    contentBase64: Buffer.from(buffer).toString('base64'),
  };
}
