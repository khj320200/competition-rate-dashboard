import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const script = await readFile(new URL('../app.js', import.meta.url), 'utf8');
function element() {
  const classes = new Set();
  return { textContent: '', value: '', children: [], disabled: false,
    classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x),
      toggle: (x, enabled) => enabled ? classes.add(x) : classes.delete(x) },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    addEventListener() {}, setAttribute() {}, removeAttribute() {} };
}
const payload = {
  university: '가톨릭대학교', fetchedAt: '2026-09-08T13:00:00.000Z', updatedAt: '2026.09.08 22:00', live: true,
  source: { url: 'https://addon.jinhakapply.com/test.html', provider: '진학어플라이' },
  admissionTypes: [{ id: '1', name: '일반전형', rows: [{ id: 'r1', name: '컴퓨터공학과', seats: 10, applicants: 30, ratio: 3 }] }]
};
function boot(data) {
  const elements = new Map();
  const document = { addEventListener() {}, querySelectorAll: () => [], createElement: element,
    getElementById: id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } };
  const context = vm.createContext({ document, URLSearchParams,
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async () => ({ ok: true, json: async () => structuredClone(data) }) });
  vm.runInContext(script, context);
  vm.runInContext('cacheDom(); state.refreshing = false;', context);
  return { elements, context, run: code => vm.runInContext(code, context) };
}

test('selecting and adding stale data warns and retains actual collection time', async () => {
  const app = boot({ ...payload, stale: true, live: false, warning: '원문 접근 거부 (403)' });
  await app.run("selectUniversity({ name: '가톨릭대학교', url: 'https://addon.jinhakapply.com/test.html' })");
  assert.match(app.elements.get('status').textContent, /403/);
  assert.equal(app.elements.get('status').classList.contains('error'), true);
  app.run("selectDepartment('1', 'r1'); addCurrent();");
  assert.equal(app.run('state.watchlist[0].refreshedAt'), payload.fetchedAt);
  assert.match(app.run('state.watchlist[0].refreshError'), /403/);
  const dateCell = app.elements.get('watchBody').children[0].children[6];
  assert.match(dateCell.textContent, /갱신 실패/);
});

test('stale refresh preserves saved values/time and is counted as a failure', async () => {
  const app = boot({ ...payload, stale: true, live: false, warning: '원문 접근 거부 (403)' });
  app.context.saved = { key: 'old', university: '가톨릭대학교', admissionId: '1', departmentId: 'r1',
    sourceUrl: payload.source.url, ratio: 2, applicants: 20, seats: 10, refreshedAt: '2026-09-08T12:00:00.000Z' };
  app.run('state.watchlist = [saved];');
  await app.run('refreshWatchlist()');
  assert.equal(app.run('state.watchlist[0].ratio'), 2);
  assert.equal(app.run('state.watchlist[0].refreshedAt'), app.context.saved.refreshedAt);
  assert.match(app.elements.get('refreshStatus').textContent, /0개 성공, 1개 실패/);
  assert.equal(app.elements.get('refreshButton').disabled, false);
});

test('fresh refresh updates values, clears warning and uses the server collection time', async () => {
  const app = boot(payload);
  app.context.saved = { key: 'old', university: '가톨릭대학교', admissionId: '1', departmentId: 'r1',
    sourceUrl: payload.source.url, ratio: 2, refreshError: 'old failure' };
  app.run('state.watchlist = [saved];');
  await app.run('refreshWatchlist()');
  assert.equal(app.run('state.watchlist[0].ratio'), 3);
  assert.equal(app.run('state.watchlist[0].refreshError'), '');
  assert.equal(app.run('state.watchlist[0].refreshedAt'), payload.fetchedAt);
  assert.match(app.elements.get('refreshStatus').textContent, /1개 항목/);
});
