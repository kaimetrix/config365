/** Client-side validation for AppLocker file uploads (publisher / hash). */

export const APPLOCKER_FILE_ACCEPT = '.exe,.dll,.msi,.ps1,.bat,.cmd,.vbs,.js,.msp,.appx,.msix';
export const APPLOCKER_FILE_MAX_BYTES = 20 * 1024 * 1024;

const EXT = /\.(exe|dll|msi|msp|ps1|bat|cmd|vbs|js|appx|msix)$/i;

export type AppLockerUpload = { fileName: string; contentBase64: string };

export function validateAppLockerUpload(file: File): string | null {
  if (!EXT.test(file.name)) {
    return 'Choose an .exe, .dll, .msi, or script file.';
  }
  if (file.size > APPLOCKER_FILE_MAX_BYTES) {
    return `File must be ${APPLOCKER_FILE_MAX_BYTES / (1024 * 1024)} MB or smaller.`;
  }
  if (file.size === 0) return 'File is empty.';
  return null;
}

export async function readAppLockerUpload(file: File): Promise<AppLockerUpload> {
  const err = validateAppLockerUpload(file);
  if (err) throw new Error(err);
  const buffer = await file.arrayBuffer();
  return {
    fileName: file.name,
    contentBase64: Buffer.from(buffer).toString('base64'),
  };
}
