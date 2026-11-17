import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}
