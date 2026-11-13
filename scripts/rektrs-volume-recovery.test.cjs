const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRecovery, verifyRecovery } = require('./rektrs-volume-recovery.cjs');

test('private archives round-trip, exclude recovery keys and leave source files unchanged', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rektrs-recovery-test-'));
  try {
    const configDirectory = path.join(root, 'config'), uploadsDirectory = path.join(root, 'uploads');
    fs.mkdirSync(configDirectory); fs.mkdirSync(uploadsDirectory);
    fs.writeFileSync(path.join(configDirectory, 'settings.env'), 'FIXTURE_SECRET=not-for-output');
    fs.writeFileSync(path.join(uploadsDirectory, 'asset.txt'), 'fixture media');
    const options = { configDirectory, uploadsDirectory, bundleId: '20261113T000001Z' };
    const result = await createRecovery(options);
    assert.equal(result.outcome, 'PASS');
    assert.equal(fs.statSync(path.join(result.directory, 'recovery.key')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(result.directory).mode & 0o777, 0o700);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.directory, 'manifest.json')));
    const entry = manifest.artifacts[0];
    const decipher = crypto.createDecipheriv('aes-256-gcm', fs.readFileSync(path.join(result.directory, 'recovery.key')), Buffer.from(entry.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'hex'));
    const plain = Buffer.concat([decipher.update(fs.readFileSync(path.join(result.directory, entry.file))), decipher.final()]);
    const members = execFileSync('tar', ['-tzf', '-'], { input: plain }).toString();
    assert.ok(members.includes('settings.env'));
    assert.ok(!members.includes('rektrs-recovery') && !members.includes('recovery.key'));
    assert.equal(fs.readFileSync(path.join(configDirectory, 'settings.env'), 'utf8'), 'FIXTURE_SECRET=not-for-output');
    await assert.rejects(createRecovery(options));
    const encryptedPath = path.join(result.directory, entry.file);
    const modified = fs.readFileSync(encryptedPath); modified[0] ^= 1; fs.writeFileSync(encryptedPath, modified);
    await assert.rejects(verifyRecovery(result.directory));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('bundle IDs cannot escape the private recovery directory', async () => {
  await assert.rejects(createRecovery({ bundleId: '../../uploads/key' }), /Invalid bundle ID/);
});
