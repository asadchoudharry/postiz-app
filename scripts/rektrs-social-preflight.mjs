/**
 * REKTRS Social Phase 0: read-only, unauthenticated public endpoint checks.
 * No credentials are loaded, no posts published and no server modified.
 * Run with Node 20+: node scripts/rektrs-social-preflight.mjs
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ALLOWED_HOSTS = new Set(['rektrs.com', 'www.rektrs.com', 'social.rektrs.com']);
const MAX_REDIRECTS = 4;
export const CHECKS = Object.freeze([
  { id: 'oauth_homepage', url: 'https://rektrs.com/social/', kind: 'home' },
  { id: 'privacy_policy', url: 'https://rektrs.com/privacy-policy/', kind: 'privacy' },
  { id: 'postiz_login_reachability', url: 'https://social.rektrs.com/', kind: 'app' },
]);

function visibleText(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function readPublicPage(url, fetcher = fetch) {
  let next = new URL(url);
  const redirects = [];
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    if (next.protocol !== 'https:' || !ALLOWED_HOSTS.has(next.hostname)) {
      return { status: 0, url: next.href, redirects, error: 'untrusted_redirect' };
    }
    let response;
    try {
      response = await fetcher(next.href, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      return { status: 0, url: next.href, redirects, error: 'network_unreachable' };
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) return { status: response.status, url: next.href, redirects, error: 'missing_location' };
      redirects.push({ status: response.status, from: next.pathname });
      next = new URL(location, next.href);
      continue;
    }
    const body = response.status === 200 ? await response.text() : '';
    return { status: response.status, url: next.href, redirects, body };
  }
  return { status: 0, url: next.href, redirects, error: 'too_many_redirects' };
}

export function assessResult(check, result) {
  const base = {
    check: check.id,
    status: result.status,
    final_url: result.url,
    redirect_count: result.redirects?.length ?? 0,
  };
  if (result.error) return { ...base, outcome: 'BLOCKED', reason: result.error };
  if (result.status !== 200) return { ...base, outcome: 'FAIL', reason: 'http_status_not_200' };
  const text = visibleText(result.body).toLowerCase();
  const final = new URL(result.url);
  if (check.kind === 'home') {
    if (!['rektrs.com', 'www.rektrs.com'].includes(final.hostname) || !/\brektrs social\b/.test(text)) {
      return { ...base, outcome: 'FAIL', reason: 'public_homepage_identity_missing' };
    }
  } else if (check.kind === 'privacy') {
    const required = ['privacy', 'google', 'youtube', 'retention', 'revok', 'delet', 'contact'];
    const missing = required.filter((term) => !text.includes(term));
    if (!['rektrs.com', 'www.rektrs.com'].includes(final.hostname) || missing.length) {
      return { ...base, outcome: 'FAIL', reason: 'privacy_content_missing', missing };
    }
  } else if (check.kind === 'app') {
    if (final.hostname !== 'social.rektrs.com' || !text || /\b403 forbidden\b/i.test(text)) {
      return { ...base, outcome: 'FAIL', reason: 'app_login_unreachable' };
    }
  }
  return { ...base, outcome: 'PASS', reason: 'public_read_only_check' };
}

export async function runPreflight(fetcher = fetch) {
  const checks = await Promise.all(CHECKS.map(async (check) => assessResult(check, await readPublicPage(check.url, fetcher))));
  return {
    kind: 'rektrs_social_read_only_preflight',
    version: 1,
    checked_at: new Date().toISOString(),
    overall: checks.every((result) => result.outcome === 'PASS') ? 'PASS' : 'NOT_READY',
    checks,
    note: 'Does not verify authenticated Postiz APIs, Google consent approval, backups, deployed revision or social-provider publishing.',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runPreflight();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.overall !== 'PASS') process.exitCode = 1;
}
