import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeContent, normalizeReviewText, formatReviewReport } from '../apps/frontend/src/components/rektrs-social/quality-rules.ts';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('plain text retains Arabic and multilingual hashtags', () => {
  const report = analyzeContent(['نشر تجريبي #السعودية #Saudi']);
  assert.equal(report.posts[0].hashtags, 2);
  assert.equal(report.posts[0].status, 'clear');
});

test('TipTap markup is normalized before counting; escaped content stays plain text', () => {
  const value = normalizeReviewText('<p>Launch &amp; review <strong>#Rektrs</strong><br/>today</p>');
  assert.match(value, /Launch & review #Rektrs/);
  assert.doesNotMatch(value, /<strong>/);
  const report = analyzeContent(['<p>Launch &amp; review <strong>#Rektrs</strong><br/>today</p>']);
  assert.equal(report.posts[0].hashtags, 1);
  assert.equal(report.posts[0].links, 0);
});

test('untrusted HTML is never executed or included in the report', () => {
  const value = normalizeReviewText('<script>alert("x")</script><p>Content ready</p>');
  assert.equal(value, 'Content ready');
  const report = formatReviewReport(analyzeContent([value]));
  assert.doesNotMatch(report, /alert/);
});

test('HTML numeric entities are decoded; stray < without a tag is preserved', () => {
  assert.equal(normalizeReviewText('<p>R&#69;KTRS &#x1F680;</p>'), 'REKTRS 🚀');
  assert.equal(normalizeReviewText('Result is < 5'), 'Result is < 5');
});

test('placeholder, duplicates and transport warnings remain advisory', () => {
  const report = analyzeContent(['TODO follow up http://sample.com', 'This is a draft #dup #dup', 'This is a draft #dup #dup']);
  assert.ok(report.attentionCount > 0);
  assert.ok(report.suggestionCount > 0);
  assert.ok(report.posts[2].findings.some((f) => f.code === 'duplicate-variant'));
});

test('review is wired only to the Next 16 editor behind a default-off flag', () => {
  const editor = read('apps/frontend/src/components/new-launch/editor.tsx');
  const auth = read('apps/frontend/src/app/(app)/auth/layout.tsx');
  const env = read('.env.example');
  assert.match(editor, /NEXT_PUBLIC_REKTRS_CONTENT_REVIEW === 'true'/);
  assert.match(editor, /RektrsContentReview/);
  assert.match(editor, /items\.map\(\(post\) => post\.content\)/);
  assert.match(auth, /NEXT_PUBLIC_REKTRS_SOCIAL_BRAND === 'true'/);
  assert.match(env, /NEXT_PUBLIC_REKTRS_SOCIAL_BRAND="false"/);
  assert.match(env, /NEXT_PUBLIC_REKTRS_CONTENT_REVIEW="false"/);
  assert.doesNotMatch(editor, /\/components\/launches\/add\.edit\.model/);
});

test('no publish/save request is introduced by the advisory review component', () => {
  const component = read('apps/frontend/src/components/rektrs-social/content-review.tsx');
  assert.match(component, /Advisory checks only/);
  assert.doesNotMatch(component, /fetch\(|axios\.|\/posts\/create|publishNow/);
});
