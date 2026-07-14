import { createHash } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { StoredScreenshot } from '@tt/shared';

export interface StoreMeta {
  width?: number | null;
  height?: number | null;
  dateFolder: string; // YYYY-MM-DD
}

/**
 * Persists screenshot bytes somewhere durable. Local FS now; a SharePoint/Graph
 * uploader can implement this same interface later with zero resolver changes.
 */
export interface ScreenshotStorageAdapter {
  readonly kind: 'local' | 'sharepoint';
  store(buffer: Buffer, meta: StoreMeta): Promise<StoredScreenshot>;
  remove(storagePath: string): Promise<void>;
}

export class LocalStorageAdapter implements ScreenshotStorageAdapter {
  readonly kind = 'local' as const;

  constructor(private readonly baseDir: string) {}

  async store(buffer: Buffer, meta: StoreMeta): Promise<StoredScreenshot> {
    const dir = resolve(this.baseDir, meta.dateFolder);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${randomUUID()}.png`);
    await writeFile(path, buffer);
    return {
      storageKind: 'local',
      storagePath: path,
      fileUrl: `file://${path.replace(/\\/g, '/')}`,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      bytes: buffer.length,
      width: meta.width ?? null,
      height: meta.height ?? null,
    };
  }

  async remove(storagePath: string): Promise<void> {
    await unlink(storagePath).catch(() => undefined);
  }
}

/**
 * Placeholder for the future SharePoint/Graph uploader. Implement `store` with a
 * Graph PUT to a drive item and return the web URL; swap it in via the factory.
 */
export class SharePointStorageAdapter implements ScreenshotStorageAdapter {
  readonly kind = 'sharepoint' as const;
  async store(): Promise<StoredScreenshot> {
    throw new Error('SharePointStorageAdapter not implemented yet — use LocalStorageAdapter for the MVP.');
  }
  async remove(): Promise<void> {
    /* no-op */
  }
}

export function createStorageAdapter(kind: string, baseDir: string): ScreenshotStorageAdapter {
  return kind === 'sharepoint' ? new SharePointStorageAdapter() : new LocalStorageAdapter(baseDir);
}
