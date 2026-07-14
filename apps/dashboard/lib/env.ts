import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

let loaded = false;

/** Load the nearest .env walking up from the dashboard's working directory. */
export function ensureEnv(): void {
  if (loaded) return;
  for (const p of ['.env', '../.env', '../../.env', '../../../.env']) {
    const f = resolve(process.cwd(), p);
    if (existsSync(f)) {
      dotenv.config({ path: f });
      break;
    }
  }
  loaded = true;
}
