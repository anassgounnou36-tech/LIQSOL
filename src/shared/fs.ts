import fs from 'node:fs';
import path from 'node:path';

/**
 * Atomic JSON file writer
 * Writes to a temp file and then renames to avoid partial reads
 * Rename is atomic on POSIX; reliable enough on Windows for local dev
 */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `${path.basename(filePath)}.tmp`);
  const json = JSON.stringify(data, null, 2);

  // Ensure directory exists
  await fs.promises.mkdir(dir, { recursive: true });
  
  // Write to temp file
  await fs.promises.writeFile(tmpPath, json, { encoding: 'utf8' });
  
  // Atomic rename
  await fs.promises.rename(tmpPath, filePath);
}
