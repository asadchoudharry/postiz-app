// Real component interaction tests in jsdom. Does not assert visual fidelity.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { resolve } = require('node:path');
const { JSDOM } = require('jsdom');
const React = require('react');
const { buildSync } = require('esbuild');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
Object.defineProperty(global, 'navigator', { configurable: true, value: dom.window.navigator });
const { render, fireEvent, cleanup, waitFor } = require('@testing-library/react');
const fixture = mkdtempSync(resolve(__dirname, '../../node_modules/.rektrs-review-test-'));
buildSync({
  entryPoints: [resolve(__dirname, '../../apps/frontend/src/components/launches/rektrs-content-review.tsx')],
  outfile: resolve(fixture, 'review.cjs'), bundle: true, platform: 'node', format: 'cjs',
  jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
});
const { RektrsContentReview } = require(resolve(fixture, 'review.cjs'));
const show = (contents = ['Our campaign launches on [date]. #صناعة #صناعة']) =>
  render(React.createElement(RektrsContentReview, { contents, channelCount: 2 }));
test.afterEach(cleanup);
test.after(() => { dom.window.close(); rmSync(fixture, { recursive: true, force: true }); });

test('details expand and collapse without submitting the composer', () => {
  const view = show();
  const toggle = view.getByRole('button', { name: 'View details' });
  assert.equal(toggle.type, 'button');
  const target = document.getElementById(toggle.getAttribute('aria-controls'));
  assert.equal(target.hidden, true);
  fireEvent.click(toggle);
  assert.equal(target.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  fireEvent.click(toggle);
  assert.equal(target.hidden, true);
});

test('editing the supplied draft recomputes the live findings', () => {
  const view = show();
  assert.equal(view.getByRole('status').textContent, 'Needs attention');
  view.rerender(React.createElement(RektrsContentReview, {
    contents: ['Introducing our updated service experience for teams across the region.'], channelCount: 1,
  }));
  assert.equal(view.getByRole('status').textContent, 'No editorial flags');
  assert.ok(view.getByText('1 channel selected'));
});

test('copy writes the actual review report and acknowledges success', async () => {
  let written;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { written = text; } } });
  const view = show();
  fireEvent.click(view.getByRole('button', { name: 'Copy review' }));
  await waitFor(() => assert.ok(view.getByText('Review copied to clipboard.')));
  assert.ok(written.includes('Post 1'));
  assert.ok(written.includes('placeholder') || written.includes('Placeholder') || written.includes('unfinished'));
});

test('clipboard denial renders an actionable error without throwing', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('denied'); } } });
  const view = show();
  fireEvent.click(view.getByRole('button', { name: 'Copy review' }));
  await waitFor(() => assert.ok(view.getByText('Clipboard permission is unavailable. Review remains visible above.')));
  assert.ok(view.getByRole('heading', { name: 'Pre-publish review' }));
});
