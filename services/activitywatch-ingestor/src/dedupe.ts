import { createHash } from 'node:crypto';

/** Stable content hash used for idempotent inserts. */
export function hashKey(...parts: Array<string | null | undefined>): string {
  return createHash('sha1').update(parts.map((p) => p ?? '').join('|')).digest('hex');
}
