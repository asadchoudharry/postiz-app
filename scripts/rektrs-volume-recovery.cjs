#!/usr/bin/env node
// Private, local recovery copies. No network, environment dump or provider action.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const files = ['config.tar.gz.enc', 'uploads.tar.gz.enc'];
const tap = hash => new Transform({ transform(data, encoding, callback) { hash.update(data); callback(null, data); } });

async function tarPipeline(args, work) {
  const child = spawn('tar', args, { stdio: ['pipe', 'pipe', 'ignore'] });
  const ended = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Archive command failed')));
  });
  const copying = work(child);
  try { await Promise.all([copying, ended]); }
  catch (error) { child.kill('SIGTERM'); await Promise.allSettled([copying, ended]); throw error; }
}

async function verifyRecovery(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.algorithm !== 'aes-256-gcm' || manifest.artifacts.length !== 2) throw new Error('Invalid manifest');
  const key = fs.readFileSync(path.join(directory, 'recovery.key'));
  if (key.length !== 32) throw new Error('Invalid recovery key');
  for (let index = 0; index < files.length; index++) {
    const entry = manifest.artifacts[index];
    if (entry.file !== files[index] || !/^[a-f0-9]{24}$/.test(entry.iv) || !/^[a-f0-9]{32}$/.test(entry.tag)) throw new Error('Invalid artifact');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'hex'));
    const hash = crypto.createHash('sha256');
    // Check the decrypted archive with tar without extracting to live volumes
    // or displaying private member names.
    await tarPipeline(['-tzf', '-'], child => {
      child.stdout.resume();
      return pipeline(fs.createReadStream(path.join(directory, entry.file)), decipher, tap(hash), child.stdin);
    });
    if (hash.digest('hex') !== entry.plaintextSha256) throw new Error('Archive digest mismatch');
  }
  key.fill(0);
  return { outcome: 'PASS', artifacts: files.length, decryptAndArchiveChecks: true };
}

async function createRecovery({ configDirectory = '/config', uploadsDirectory = '/uploads', bundleId = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') } = {}) {
  if (!/^\d{8}T\d{6}Z$/.test(bundleId)) throw new Error('Invalid bundle ID');
  for (const directory of [configDirectory, uploadsDirectory]) {
    if (!fs.statSync(directory).isDirectory()) throw new Error('Source directory unavailable');
  }
  process.umask(0o077);
  const recoveryRoot = path.join(configDirectory, 'rektrs-recovery');
  fs.mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
  const directory = path.join(recoveryRoot, bundleId);
  // Existing bundles must never be overwritten.
  fs.mkdirSync(directory, { mode: 0o700 });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(path.join(directory, 'recovery.key'), key, { mode: 0o600, flag: 'wx' });
  const manifest = { version: 1, algorithm: 'aes-256-gcm', createdAt: new Date().toISOString(), artifacts: [] };
  for (const [index, source] of [configDirectory, uploadsDirectory].entries()) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const hash = crypto.createHash('sha256');
    const output = path.join(directory, files[index]);
    const args = ['-czf', '-', ...(index === 0 ? ['--exclude=./rektrs-recovery'] : []), '-C', source, '.'];
    await tarPipeline(args, child => {
      child.stdin.end();
      return pipeline(child.stdout, tap(hash), cipher, fs.createWriteStream(output, { mode: 0o600, flags: 'wx' }));
    });
    manifest.artifacts.push({ file: files[index], iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), plaintextSha256: hash.digest('hex'), bytes: fs.statSync(output).size });
  }
  key.fill(0);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const verified = await verifyRecovery(directory);
  fs.writeFileSync(path.join(directory, 'VERIFIED.json'), JSON.stringify({ ...verified, checkedAt: new Date().toISOString() }) + '\n', { mode: 0o600, flag: 'wx' });
  return { ...verified, directory, artifacts: manifest.artifacts.map(({ file, bytes }) => ({ file, bytes })), note: 'Local recovery copies; encryption key stays in the private config volume. Off-host backup and a full application restore are separate checks.' };
}

module.exports = { createRecovery, verifyRecovery };
if (require.main === module) {
  const job = process.argv[2] === '--verify'
    ? verifyRecovery(process.argv[3])
    : createRecovery({ bundleId: process.argv[2] });
  job.then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(JSON.stringify({ outcome: 'FAIL', code: error.code || 'recovery_failed' }));
    process.exitCode = 1;
  });
}
