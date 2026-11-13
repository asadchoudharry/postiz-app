import test from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight, readPublicPage, assessResult, CHECKS } from './rektrs-social-preflight.mjs';

const HOME = '<html><h1>Rektrs Social</h1><p>A public product information page</p></html>';
const PRIVACY = '<html><h1>Privacy Policy</h1><p>Google YouTube retention revoke delete contact</p></html>';
const LOGIN = '<html><h1>Sign In</h1></html>';
const success = (html) => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });

function fixture(url) {
  const target = new URL(url);
  if (target.pathname === '/social/') return success(HOME);
  if (target.pathname === '/privacy-policy/') return success(PRIVACY);
  if (target.hostname === 'social.rektrs.com' && target.pathname === '/') {
    return new Response(null, { status: 302, headers: { location: '/auth/login' } });
  }
  if (target.pathname === '/auth/login') return success(LOGIN);
  return new Response('missing', { status: 404 });
}

test('valid public pages and app sign-in count as ready without credentials', async () => {
  const result = await runPreflight(async (url) => fixture(url));
  assert.equal(result.overall, 'PASS');
  assert.equal(result.checks.length, 3);
  assert.ok(result.checks.every((entry) => entry.outcome === 'PASS'));
});

test('Google policy page must cover purpose, control, and deletion', async () => {
  const result = await runPreflight(async (url) => url.endsWith('/privacy-policy/') ? success('<h1>Privacy</h1>') : fixture(url));
  assert.equal(result.overall, 'NOT_READY');
  assert.equal(result.checks[1].reason, 'privacy_content_missing');
  assert.ok(result.checks[1].missing.includes('youtube'));
});

test('Postiz upstream 403 fails without claiming WAF root cause', async () => {
  const result = await runPreflight(async (url) => url === 'https://social.rektrs.com/' ? new Response('Forbidden', { status: 403 }) : fixture(url));
  assert.equal(result.overall, 'NOT_READY');
  assert.equal(result.checks[2].status, 403);
  assert.equal(result.checks[2].reason, 'http_status_not_200');
});

test('external redirects are blocked without fetching target', async () => {
  let calls = 0;
  const result = await readPublicPage('https://rektrs.com/social/', async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'https://example.org/private' } });
  });
  assert.equal(result.error, 'untrusted_redirect');
  assert.equal(calls, 1);
});

test('network errors result in BLOCKED instead of false success', async () => {
  const result = await runPreflight(async () => { throw new Error('no DNS'); });
  assert.equal(result.overall, 'NOT_READY');
  assert.ok(result.checks.every((entry) => entry.outcome === 'BLOCKED'));
});

test('a login page presented as public OAuth homepage is rejected', () => {
  const out = assessResult(CHECKS[0], { status: 200, url: 'https://rektrs.com/auth/login', redirects: [], body: LOGIN });
  assert.equal(out.reason, 'public_homepage_identity_missing');
});
