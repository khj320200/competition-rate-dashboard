import { once } from 'node:events';
import { server } from '../server.mjs';

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const probes = [
  ['health', '/api/health'],
  ['university-search', '/api/universities/search?q=%EA%B0%80%ED%86%A8%EB%A6%AD'],
  ['jinhak-catholic', '/api/competition?university=catholic&refresh=1'],
  ['uway-far-east', '/api/competition?university=far-east&refresh=1']
];
try {
  await Promise.all(probes.map(async ([name, path]) => {
    const started = Date.now();
    try {
      const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(90_000) });
      const data = await response.json();
      const rows = data.admissionTypes?.reduce((count, type) => count + type.rows.length, 0);
      const ok = response.ok && !data.stale && (rows === undefined || rows > 0);
      if (!ok) process.exitCode = 1;
      console.log(JSON.stringify({ name, ok, status: response.status, elapsedMs: Date.now() - started,
        results: Array.isArray(data) ? data.length : undefined, rows, updatedAt: data.updatedAt,
        scraper: data.scraper, code: data.code, error: data.error }));
    } catch {
      process.exitCode = 1;
      console.log(JSON.stringify({ name, ok: false, elapsedMs: Date.now() - started, error: '진단 요청 실패 또는 시간 초과' }));
    }
  }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
