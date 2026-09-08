import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { once } from 'node:events';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import iconv from 'iconv-lite';

process.env.SCRAPER_PROXY_URL = '';
process.env.SCRAPER_PROXY_HOSTS = 'addon.jinhakapply.com';
const originalDispatcher = getGlobalDispatcher();
const mock = new MockAgent();
mock.disableNetConnect();
setGlobalDispatcher(mock);
const { server } = await import('../server.mjs');
let origin;

before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  for (const host of ['https://addon.jinhakapply.com', 'https://info.uway.com']) {
    mock.get(host).intercept({ path: '/' }).reply(200, '<html></html>').persist();
  }
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  await mock.close();
  setGlobalDispatcher(originalDispatcher);
});

function request(path) {
  return new Promise((resolve, reject) => {
    get(`${origin}${path}`, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let json; try { json = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, text, json });
      });
    }).on('error', reject);
  });
}

test('public static files work; configuration/source/dependencies are not served', async () => {
  for (const path of ['/', '/app.js', '/styles.css']) assert.equal((await request(path)).status, 200);
  for (const path of ['/.env', '/.env.example', '/server.mjs', '/scraper-fetch.mjs', '/package.json', '/.git/config', '/node_modules/undici/package.json']) {
    assert.equal((await request(path)).status, 404, path);
  }
  assert.deepEqual((await request('/api/health')).json, { status: 'ok', scraper: { proxyConfigured: false, proxyHosts: [] } });
});

test('live parse succeeds; later 403 returns original cached data explicitly stale', async () => {
  const path = '/RatioV1/RatioH/Ratio10030381.html';
  mock.get('https://addon.jinhakapply.com').intercept({ path }).reply(200,
    '<h1>2027학년도</h1><span id="RatioTime">2026.09.08 17:00</span><div id="SelType1"><h2>일반전형</h2><table class="tableRatio3"><tr><th>모집단위</th><th>모집인원</th><th>지원인원</th><th>경쟁률</th></tr><tr><td>컴퓨터공학과</td><td>10</td><td>30</td><td>3.00 : 1</td></tr></table></div>');
  const fresh = await request('/api/competition?university=catholic&refresh=1');
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json.live, true);
  assert.equal(fresh.json.admissionTypes[0].rows[0].ratio, 3);
  mock.get('https://addon.jinhakapply.com').intercept({ path }).reply(403, 'Forbidden');
  const stale = await request('/api/competition?university=catholic&refresh=1');
  assert.equal(stale.status, 200);
  assert.equal(stale.json.live, false);
  assert.equal(stale.json.stale, true);
  assert.equal(stale.json.fetchedAt, fresh.json.fetchedAt);
  assert.match(stale.json.warning, /403/);
});

test('uncached 403 produces an actionable 502 response', async () => {
  mock.get('https://addon.jinhakapply.com').intercept({ path: '/blocked.html' }).reply(403, 'Forbidden');
  const result = await request('/api/competition?url=https%3A%2F%2Faddon.jinhakapply.com%2Fblocked.html');
  assert.equal(result.status, 502);
  assert.equal(result.json.code, 'UPSTREAM_FORBIDDEN');
});

test('Uway search distinguishes valid no-results, decoded rows and HTTP 200 block pages', async () => {
  const path = '/power/?v_mode=school_nm_view&R_SearchText=%B0%A1%C5%E7%B8%AF';
  const pool = mock.get('https://info.uway.com');
  pool.intercept({ path }).reply(200, iconv.encode('<h1>경쟁률</h1><table><tr><td abbr="서울"></td><td abbr="4년제 수시"></td><td abbr="가톨릭대학교"></td><td abbr="2026.09.07 ~ 2026.09.11"><a href="https://addon.jinhakapply.com/RatioV1/RatioH/Ratio10030381.html">경쟁률</a></td></tr></table>', 'euc-kr'));
  const pathApi = '/api/universities/search?q=%EA%B0%80%ED%86%A8%EB%A6%AD';
  const result = await request(pathApi);
  assert.equal(result.status, 200);
  assert.equal(result.json[0].name, '가톨릭대학교');
  pool.intercept({ path }).reply(200, iconv.encode('<h1>경쟁률</h1><table><tr><td>검색 결과가 없습니다.</td></tr></table>', 'euc-kr'));
  assert.deepEqual((await request(pathApi)).json, []);
  pool.intercept({ path }).reply(200, '<h1>Access Denied</h1>');
  const blocked = await request(pathApi);
  assert.equal(blocked.status, 502);
  assert.equal(blocked.json.code, 'UPSTREAM_BLOCK_PAGE');
  assert.equal((await request('/api/universities/search?q=a')).status, 400);
});

test('unsafe URL or redirect is rejected before reaching another host', async () => {
  const invalid = await request('/api/competition?url=https%3A%2F%2Flocalhost%2F');
  assert.equal(invalid.status, 400);
  mock.get('https://addon.jinhakapply.com').intercept({ path: '/redirect.html' }).reply(302, '', { headers: { location: 'https://localhost/private' } });
  const redirected = await request('/api/competition?url=https%3A%2F%2Faddon.jinhakapply.com%2Fredirect.html');
  assert.equal(redirected.status, 502);
  assert.equal(redirected.json.code, 'INVALID_SOURCE');
});
