import { readFile, mkdir, writeFile } from 'node:fs/promises';
const artifact = JSON.parse(await readFile(new URL('../contracts/out/TipEscrow.sol/TipEscrow.json', import.meta.url), 'utf8'));
const target = new URL('../packages/services/src/chain/', import.meta.url);
await mkdir(target, { recursive: true });
await writeFile(new URL('escrow-artifact.json', target), JSON.stringify({ abi: artifact.abi, bytecode: artifact.bytecode.object }, null, 2) + '\n');
console.log('Updated the escrow ABI and deployment bytecode from the compiled Foundry artifact.');
