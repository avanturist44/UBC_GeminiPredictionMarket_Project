import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Local development reads the repo-root .env. Deployed, variables come from the host.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@thesis/core', '@thesis/db'],
  // Their source imports workspace files without extensions.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
};

export default config;
