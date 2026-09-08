import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createScraperTransport, validateSourceUrl, checkUpstreamStatus, checkHtmlResponse } from '../scraper-fetch.mjs';

test('proxy applies to both Jinhak warmup and detail; Uway stays direct', async () => {
  const requests = [];
  let settings;
  const dispatcher = { close: async () => {} };
  const transport = createScraperTransport({
    proxyUrl: 'http://user:p%40ss@proxy.example:8080',
    createDispatcher: (options) => { settings = options; return dispatcher; },
    fetchImpl: async (url, options) => { requests.push({ url, options }); return new Response('ok'); }
  });
  await transport.fetch('https://addon.jinhakapply.com/');
  await transport.fetch('https://addon.jinhakapply.com/RatioV1/RatioH/test.html');
  await transport.fetch('https://ratio.uwayapply.com/test');
  await transport.fetch('https://info.uway.com/power/');
  assert.equal(settings.uri, 'http://proxy.example:8080');
  assert.equal(settings.token, `Basic ${Buffer.from('user:p@ss').toString('base64')}`);
  assert.equal(requests[0].options.dispatcher, dispatcher);
  assert.equal(requests[1].options.dispatcher, dispatcher);
  assert.equal(requests[2].options.dispatcher, undefined);
  assert.equal(requests[3].options.dispatcher, undefined);
  assert.equal(requests[0].options.redirect, 'manual');
  assert.ok(!JSON.stringify(transport.status).includes('proxy.example'));
  assert.ok(!JSON.stringify(requests).includes('p@ss'));
  await transport.close();
});

test('missing proxy preserves direct mode and errors never expose credentials or retry directly', async () => {
  const direct = createScraperTransport({ proxyUrl: '', fetchImpl: async (_, options) => {
    assert.equal(options.dispatcher, undefined);
    return new Response('ok');
  } });
  await direct.fetch('https://addon.jinhakapply.com/');
  assert.equal(direct.status.proxyConfigured, false);
  let calls = 0;
  const proxied = createScraperTransport({
    proxyUrl: 'http://user:secret@proxy.example:8080',
    createDispatcher: () => ({ close: async () => {} }),
    fetchImpl: async () => { calls++; throw new Error('http://user:secret@proxy.example'); }
  });
  await assert.rejects(proxied.fetch('https://addon.jinhakapply.com/'), (error) => {
    assert.equal(error.code, 'PROXY_CONNECTION_FAILED');
    assert.ok(!String(error).includes('secret'));
    assert.ok(!String(error).includes('proxy.example'));
    return true;
  });
  assert.equal(calls, 1);
});

test('invalid proxy config fails closed without echoing secret', () => {
  for (const proxyUrl of ['socks5://user:secret@proxy.example', 'https://proxy.example/path?secret=1', 'secret']) {
    assert.throws(() => createScraperTransport({ proxyUrl }), error => error.code === 'PROXY_CONFIG' && !String(error).includes('secret'));
  }
  assert.throws(() => createScraperTransport({ proxyHosts: 'localhost' }), { code: 'PROXY_CONFIG' });
});

test('source and redirect destinations cannot use credentials, other protocols/ports or hosts', () => {
  for (const url of ['http://addon.jinhakapply.com/', 'https://addon.jinhakapply.com:8443/', 'https://user:secret@addon.jinhakapply.com/', 'https://localhost/', 'https://addon.jinhakapply.com.evil.example/']) {
    assert.throws(() => validateSourceUrl(url), { code: 'INVALID_SOURCE' });
  }
  assert.throws(() => validateSourceUrl('https://info.uway.com/', new Set(['addon.jinhakapply.com'])), { code: 'INVALID_SOURCE' });
});

test('403, 429, 407 and timeout have actionable error codes', async () => {
  for (const [status, code] of [[403, 'UPSTREAM_FORBIDDEN'], [429, 'UPSTREAM_RATE_LIMITED'], [407, 'PROXY_AUTH_FAILED']]) {
    assert.throws(() => checkUpstreamStatus(new Response('', { status }), 'https://addon.jinhakapply.com/', false), { code });
  }
  const transport = createScraperTransport({ proxyUrl: '', fetchImpl: async () => { throw new DOMException('timeout', 'TimeoutError'); } });
  await assert.rejects(transport.fetch('https://addon.jinhakapply.com/'), { code: 'UPSTREAM_TIMEOUT' });
});

test('HTTP 200 block page is not mistaken for empty data', () => {
  for (const html of ['<h1>Access Denied</h1>', '<p>해외 IP에서의 접속을 제한합니다.</p>', '<p>비정상적인 접근입니다.</p>']) {
    assert.throws(() => checkHtmlResponse(html), { code: 'UPSTREAM_BLOCK_PAGE' });
  }
  assert.doesNotThrow(() => checkHtmlResponse('<script>var message="Access denied";</script><table><tr><td>경쟁률</td></tr></table>'));
});

test('real CONNECT proxy receives authentication and reports 407 without exposing it', async () => {
  let received;
  const proxy = createServer();
  proxy.on('connect', (request, socket) => {
    received = { destination: request.url, authorization: request.headers['proxy-authorization'] };
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const transport = createScraperTransport({ proxyUrl: `http://test:private@127.0.0.1:${proxy.address().port}` });
  try {
    await assert.rejects(transport.fetch('https://addon.jinhakapply.com/', { signal: AbortSignal.timeout(3000) }), error => {
      assert.equal(error.code, 'PROXY_AUTH_FAILED');
      assert.ok(!String(error).includes('private'));
      return true;
    });
    assert.equal(received.destination, 'addon.jinhakapply.com:443');
    assert.equal(received.authorization, `Basic ${Buffer.from('test:private').toString('base64')}`);
  } finally {
    await transport.close();
    await new Promise(resolve => proxy.close(resolve));
  }
});
