import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A server file that imports a value from a 'use client' module gets a client reference,
 * not the value: reading it on the server gives `undefined`. That is how the home feed once
 * queried for authors of kind `undefined` and failed. Components may cross the boundary
 * (they are rendered, not read); constants, maps and helpers must live in a plain module.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) out.push(path);
    }
  };
  for (const dir of ['app', 'components', 'lib']) walk(join(ROOT, dir));
  return out;
}

const isClient = (source: string) => /^\s*['"]use client['"]/.test(source);
/** A component name: a capital letter followed by a lower-case one, like `HomeFeed`. */
const isComponentName = (name: string) => /^[A-Z][a-z]/.test(name);

describe('the server and client boundary', () => {
  it('no server file imports a non-component value from a client module', () => {
    const files = sourceFiles();
    const clientModules = new Set(
      files.filter((f) => isClient(readFileSync(f, 'utf8'))).map((f) => `@/${relative(ROOT, f).replace(/\.(tsx|ts)$/, '')}`),
    );
    expect(clientModules.size).toBeGreaterThan(0);

    const problems: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (isClient(source)) continue;
      for (const match of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g)) {
        const [, typeOnly, names, from] = match;
        if (typeOnly || !from || !clientModules.has(from)) continue;
        const values = (names ?? '')
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part && !part.startsWith('type '))
          .map((part) => part.split(/\s+as\s+/)[0]!)
          .filter((name) => !isComponentName(name));
        for (const name of values) problems.push(`${relative(ROOT, file)} imports ${name} from ${from}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
