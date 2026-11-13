import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const flag = "NEXT_PUBLIC_REKTRS_SOCIAL_BRAND === 'true'";

test('REKTRS identity is explicitly opt-in and not active by default', () => {
  const config = read('.env.example');
  assert.match(config, /# NEXT_PUBLIC_REKTRS_SOCIAL_BRAND="true"/);
  assert.doesNotMatch(config, /^NEXT_PUBLIC_REKTRS_SOCIAL_BRAND=/m);
});

test('both login and authenticated navigation preserve existing fallback', () => {
  for (const path of [
    'apps/frontend/src/app/auth/layout.tsx',
    'apps/frontend/src/components/layout/layout.settings.tsx',
  ]) {
    const content = read(path);
    assert.ok(content.includes(flag), path + ' is missing the opt-in guard');
    assert.ok(content.includes('REKTRS <span'), path + ' is missing wordmark');
    assert.ok(content.includes('/postiz.svg'), path + ' unexpectedly removed upstream logo');
    assert.ok(content.includes('/logo.svg'), path + ' unexpectedly removed legacy logo');
  }
});

test('login and registration titles use consent-screen brand only when enabled', () => {
  for (const path of [
    'apps/frontend/src/app/auth/login/page.tsx',
    'apps/frontend/src/app/auth/page.tsx',
  ]) {
    const content = read(path);
    assert.ok(content.includes(flag), path + ' missing brand guard');
    assert.ok(content.includes('REKTRS Social'), path + ' missing app name');
    assert.ok(content.includes('isGeneralServerSide()'), path + ' missing fallback');
  }
});

test('login exposes public product and privacy links without changing authentication', () => {
  const content = read('apps/frontend/src/components/auth/login.tsx');
  assert.ok(content.includes(flag));
  assert.ok(content.includes('https://rektrs.com/social/'));
  assert.ok(content.includes('https://rektrs.com/privacy-policy/'));
  assert.ok(content.includes("form.handleSubmit(onSubmit)"));
  assert.ok(content.includes("fetchData('/auth/login'"));
});
