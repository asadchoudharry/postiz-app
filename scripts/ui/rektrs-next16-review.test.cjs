// React 19 component interaction tests against the actual Next 16 port.
// Does not imply browser/visual fidelity, server approval, or production readiness.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: dom.window.navigator,
});

const { render, fireEvent, cleanup, waitFor } = require('@testing-library/react');
const root = path.resolve(__dirname, '../..');
const fixture = fs.mkdtempSync(path.join(root, 'node_modules', '.rektrs-next16-review-'));

function compile(source, filename) {
  const input = path.join(root, 'apps/frontend/src/components/rektrs-social', source);
  const output = ts.transpileModule(fs.readFileSync(input, 'utf8'), {
    fileName: input,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  fs.writeFileSync(path.join(fixture, filename), output.outputText);
}
compile('quality-rules.ts', 'quality-rules.js');
compile('content-review.tsx', 'content-review.js');
const { RektrsContentReview } = require(path.join(fixture, 'content-review.js'));

function show(contents = ['Our campaign launches on [date]. #صناعة #صناعة'], channelCount = 2) {
  return render(React.createElement(RektrsContentReview, { contents, channelCount }));
}
test.afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
});
test.after(() => {
  dom.window.close();
  fs.rmSync(fixture, { force: true, recursive: true });
});

test('details expand and collapse through a non-submit button', () => {
  const view = show();
  const toggle = view.getByRole('button', { name: 'View details' });
  assert.equal(toggle.type, 'button');
  const details = document.getElementById(toggle.getAttribute('aria-controls'));
  assert.ok(details);
  assert.equal(details.hidden, true);
  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(details.hidden, false);
  fireEvent.click(toggle);
  assert.equal(details.hidden, true);
});

test('rerender uses the current draft and channel selection rather than stale values', () => {
  const view = show();
  assert.equal(view.getByRole('status').textContent, 'Needs attention');
  view.rerender(React.createElement(RektrsContentReview, {
    contents: ['Introducing our updated service experience for teams across the region.'],
    channelCount: 1,
  }));
  assert.equal(view.getByRole('status').textContent, 'No editorial flags');
  assert.ok(view.getByText('1 channel selected'));
});

test('TipTap HTML is reviewed as text, not rendered as markup', () => {
  const view = show(['<p>Launch &amp; review <strong>#Rektrs</strong> for today</p>']);
  fireEvent.click(view.getByRole('button', { name: 'View details' }));
  assert.ok(view.getByText('1 hashtags'));
  assert.equal(view.container.querySelector('script'), null);
});

test('copy writes the actual report and acknowledges success', async () => {
  let written = null;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: async text => { written = text; } },
  });
  const view = show();
  fireEvent.click(view.getByRole('button', { name: 'Copy review' }));
  await waitFor(() => assert.ok(view.getByText('Review copied to clipboard.')));
  assert.match(written, /Post 1/);
  assert.match(written, /Replace unfinished placeholders/);
});

test('clipboard failure is user-visible without throwing or publishing', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async () => { throw new Error('permission denied'); } },
  });
  const view = show();
  fireEvent.click(view.getByRole('button', { name: 'Copy review' }));
  await waitFor(() => assert.ok(view.getByText(
    'Clipboard permission is unavailable. Review remains visible above.'
  )));
  assert.ok(view.getByRole('heading', { name: 'Pre-publish review' }));
});
