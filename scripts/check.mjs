import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, filter, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, found);
    else if (filter(full)) found.push(full);
  }
  return found;
}

const sources = [
  ...walk(path.join(projectRoot, 'src'), () => true),
  ...walk(path.join(projectRoot, 'bin'), () => true),
  ...walk(path.join(projectRoot, 'test'), () => true),
];

let failed = 0;
process.stdout.write('syntax check\n');
for (const file of sources) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status === 0) {
    process.stdout.write(`  ok   ${path.relative(projectRoot, file)}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  FAIL ${path.relative(projectRoot, file)}\n${result.stderr}\n`);
  }
}

const secrets = [
  { pattern: /ghp_[A-Za-z0-9]{20,}/, label: 'GitHub personal access token' },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/, label: 'GitHub fine-grained token' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'private key' },
  { pattern: /AKIA[0-9A-Z]{16}/, label: 'AWS access key id' },
];

process.stdout.write('\nsecret scan\n');
const scanTargets = walk(projectRoot, (file) => /\.(js|mjs|json|md|yml|yaml)$/.test(file));
let secretHits = 0;
for (const file of scanTargets) {
  const content = fs.readFileSync(file, 'utf8');
  for (const { pattern, label } of secrets) {
    if (pattern.test(content)) {
      secretHits += 1;
      process.stdout.write(`  FAIL ${path.relative(projectRoot, file)} looks like a ${label}\n`);
    }
  }
}
if (secretHits === 0) process.stdout.write('  ok   no credential patterns in tracked text files\n');

const configPath = path.join(projectRoot, 'config.json');
if (fs.existsSync(configPath)) {
  process.stdout.write(`\n  FAIL config.json exists in the project root; it holds tokens. Keep it in ~/.termux-mcp/\n`);
  secretHits += 1;
}

process.stdout.write(failed + secretHits === 0 ? '\nchecks passed\n' : '\nchecks failed\n');
process.exit(failed + secretHits === 0 ? 0 : 1);
