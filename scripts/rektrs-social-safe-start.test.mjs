import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');

function makeStub(rootDir, name) {
  const stub = path.join(rootDir, name);
  fs.writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "' + name + ' $*" >> "$REKTRS_STUB_LOG"\n');
  fs.chmodSync(stub, 0o755);
}
function execute(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rektrs-safe-start-'));
  const log = path.join(dir, 'commands.log');
  fs.writeFileSync(log, '');
  try {
    for (const program of ['nginx', 'pnpm', 'pm2']) makeStub(dir, program);
    const result = spawnSync('sh', [new URL('scripts/rektrs-social-start.sh', root).pathname], {
      encoding: 'utf8',
      env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH,
        REKTRS_STUB_LOG: log, REKTRS_ALLOW_AUTOMATIC_SCHEMA_SYNC: 'false', ...extraEnv },
    });
    return { ...result, commands: fs.readFileSync(log, 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('approved process-only entrypoint never invokes database sync', () => {
  const result = execute();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.commands, /^nginx /m);
  for (const packageName of ['backend', 'orchestrator', 'frontend']) {
    assert.ok(result.commands.includes('pnpm --filter ./apps/' + packageName + ' run pm2'));
  }
  assert.match(result.commands, /pm2 logs/);
  assert.doesNotMatch(result.commands, /prisma|db push|migrat|publish/i);
});

test('unsafe automatic schema sync flag is refused before even starting nginx', () => {
  const result = execute({ REKTRS_ALLOW_AUTOMATIC_SCHEMA_SYNC: 'true' });
  assert.equal(result.status, 64);
  assert.equal(result.commands, '');
  assert.match(result.stderr, /REFUSED/);
});

test('release-specific Dockerfile has explicit provenance and build-time flags', () => {
  const docker = read('Dockerfile.rektrs');
  const entry = read('scripts/rektrs-social-start.sh');
  assert.match(docker, /ARG REKTRS_SOURCE_REVISION/);
  assert.match(docker, /RUN test -n "\$REKTRS_SOURCE_REVISION"/);
  assert.match(docker, /org\.opencontainers\.image\.revision/);
  assert.match(docker, /ARG NEXT_PUBLIC_REKTRS_SOCIAL_BRAND=false/);
  assert.match(docker, /ARG NEXT_PUBLIC_REKTRS_CONTENT_REVIEW=false/);
  assert.match(docker, /scripts\/rektrs-social-start\.sh/);
  // Scan executable directives, not explanatory comments describing the blocked path.
  const executable = (docker + '\n' + entry).split('\n')
    .filter(line => !line.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(executable, /db push|accept-data-loss|pm2-run/);
  assert.doesNotMatch(executable, /ghcr\.io\/gitroomhq/);
});
