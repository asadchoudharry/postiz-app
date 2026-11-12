import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeContent, formatReviewReport } from '../apps/frontend/src/components/launches/rektrs-quality-rules.ts';

test('an empty draft is flagged but cannot publish or mutate anything', () => {
  const result = analyzeContent(['']);
  assert.equal(result.attentionCount, 1);
  assert.equal(result.posts[0].status, 'needs-attention');
  assert.equal(result.posts[0].findings[0].code, 'too-short');
});

test('clean, longer copy yields no flags', () => {
  const result = analyzeContent(['Introducing our updated service experience for teams across the region.']);
  assert.equal(result.attentionCount, 0);
  assert.equal(result.suggestionCount, 0);
  assert.equal(result.posts[0].score, 100);
});

test('unfinished placeholders must be corrected', () => {
  const result = analyzeContent(['Our product launches on [date]. Learn more at {{campaign_url}}.']);
  assert.ok(result.posts[0].findings.some((f) => f.code === 'placeholder' && f.severity === 'attention'));
});

test('same hashtag in mixed case is detected', () => {
  const result = analyzeContent(['Follow this announcement #Rektrs #REKTRS']);
  assert.ok(result.posts[0].findings.some((f) => f.code === 'repeated-hashtag'));
  assert.equal(result.posts[0].hashtags, 2);
});

test('unicode hashtags in Arabic and Latin are handled', () => {
  const result = analyzeContent(['نعمل مع الفرق في السعودية #الرياض #Rektrs']);
  assert.equal(result.posts[0].hashtags, 2);
  assert.ok(result.posts[0].words >= 5);
});

test('duplicate post variants trigger an advisory suggestion only', () => {
  const result = analyzeContent(['Hello REKTRS community.', ' hello   rektrs community. ']);
  assert.equal(result.attentionCount, 0);
  assert.ok(result.posts[1].findings.some((f) => f.code === 'duplicate-variant'));
});

test('non-HTTPS links and excessive links are advisory, not automatic blocking', () => {
  const result = analyzeContent(['Our links: http://example.org/a https://example.org/b https://example.org/c https://example.org/d']);
  assert.ok(result.posts[0].findings.some((f) => f.code === 'http-link'));
  assert.ok(result.posts[0].findings.some((f) => f.code === 'many-links'));
  assert.equal(result.attentionCount, 0);
});

test('very long unbroken text is a readability suggestion', () => {
  const result = analyzeContent(['A'.repeat(330)]);
  assert.ok(result.posts[0].findings.some((f) => f.code === 'long-line'));
});

test('scores cannot go below zero or above one hundred', () => {
  const result = analyzeContent(['[link] TODO ' + '!!!'.repeat(10) + '#x '.repeat(15) + 'http://example.org/a '.repeat(5)]);
  assert.ok(result.posts[0].score >= 0 && result.posts[0].score <= 100);
});

test('report formatting includes every post and a non-authoritative disclaimer', () => {
  const result = analyzeContent(['Post one is complete.', 'Post two is also complete.']);
  const text = formatReviewReport(result);
  assert.match(text, /Post 1:/);
  assert.match(text, /Post 2:/);
  assert.match(text, /advisory only/);
});

test('source is opt-in, appears above save controls and leaves submission logic unchanged', () => {
  const src = readFileSync(new URL('../apps/frontend/src/components/launches/add.edit.model.tsx', import.meta.url), 'utf8');
  const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(env, /# NEXT_PUBLIC_REKTRS_CONTENT_REVIEW="true"/);
  assert.doesNotMatch(env, /^NEXT_PUBLIC_REKTRS_CONTENT_REVIEW=/m);
  assert.match(src, /NEXT_PUBLIC_REKTRS_CONTENT_REVIEW === 'true'/);
  assert.ok(src.indexOf('<RektrsContentReview') < src.indexOf("onClick={schedule('draft')}"));
  assert.match(src, /onClick=\{schedule\('schedule'\)\}/);
  assert.match(src, /onClick=\{schedule\('draft'\)\}/);
});
