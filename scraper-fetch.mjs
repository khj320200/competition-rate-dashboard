import { fetch, ProxyAgent } from 'undici';

export const SOURCE_HOSTS = new Set([
  'addon.jinhakapply.com', 'apply.jinhakapply.com', 'ratio.uwayapply.com', 'info.uway.com'
]);

export class ScraperError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScraperError';
    this.code = code;
  }
}

export function validateSourceUrl(value, allowedHosts = SOURCE_HOSTS) {
  let url;
  try { url = new URL(value); } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port
    || !SOURCE_HOSTS.has(url.hostname) || !allowedHosts.has(url.hostname)) {
    throw new ScraperError('INVALID_SOURCE', '허용되지 않은 원문 주소입니다.');
  }
  return url;
}

export function createScraperTransport({
  proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.SCRAPER_PROXY_URL || '',
  proxyHosts = process.env.SCRAPER_PROXY_HOSTS || (process.env.HTTP_PROXY || process.env.HTTPS_PROXY ? [...SOURCE_HOSTS].join(',') : 'addon.jinhakapply.com'),
  fetchImpl = fetch,
  createDispatcher = (options) => new ProxyAgent(options)
} = {}) {
  const hosts = new Set(String(proxyHosts).split(',').map((host) => host.trim().toLowerCase()).filter(Boolean));
  if (!hosts.size || [...hosts].some((host) => !SOURCE_HOSTS.has(host))) {
    throw new ScraperError('PROXY_CONFIG', 'SCRAPER_PROXY_HOSTS에는 지원하는 원문 도메인만 입력하세요.');
  }
  let dispatcher;
  if (proxyUrl.trim()) {
    try {
      const proxy = new URL(proxyUrl.trim());
      if (!['http:', 'https:'].includes(proxy.protocol) || (proxy.pathname !== '/' && proxy.pathname !== '') || proxy.search || proxy.hash) throw new Error();
      const token = proxy.username || proxy.password
        ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
        : undefined;
      dispatcher = createDispatcher({ uri: proxy.origin, ...(token ? { token } : {}) });
    } catch {
      throw new ScraperError('PROXY_CONFIG', '프록시 주소를 확인하세요. HTTP/HTTPS 프록시 주소(예: http://ip:port)가 필요합니다.');
    }
  }

  const usesProxy = (host) => Boolean(dispatcher && hosts.has(host));
  return {
    status: { proxyConfigured: Boolean(dispatcher), proxyHosts: dispatcher ? [...hosts] : [] },
    usesProxy,
    async fetch(value, options = {}) {
      const url = validateSourceUrl(value);
      const proxied = usesProxy(url.hostname);
      try {
        return await fetchImpl(url, {
          ...options,
          redirect: 'manual',
          ...(proxied ? { dispatcher } : {})
        });
      } catch (error) {
        const causes = [];
        for (let cause = error; cause && causes.length < 5; cause = cause.cause) causes.push(cause);
        if (proxied && causes.some(cause => /Proxy (?:response \(407\)|Authentication Required \(407\))/.test(cause.message || ''))) {
          throw new ScraperError('PROXY_AUTH_FAILED', '프록시 인증에 실패했습니다. 서버 환경변수의 인증 정보를 확인하세요.');
        }
        if (options.signal?.aborted || causes.some(cause => cause.name === 'TimeoutError' || cause.code === 'UND_ERR_CONNECT_TIMEOUT')) {
          throw new ScraperError('UPSTREAM_TIMEOUT', `${url.hostname} ${proxied ? '프록시 ' : ''}연결 시간이 초과됐습니다. 잠시 후 다시 시도하세요.`);
        }
        throw new ScraperError(proxied ? 'PROXY_CONNECTION_FAILED' : 'UPSTREAM_CONNECTION_FAILED',
          proxied ? '국내 프록시 연결에 실패했습니다. 프록시 주소·인증·IP 허용 설정을 확인하세요.' : `${url.hostname} 원문 서버에 연결하지 못했습니다.`);
      }
    },
    async close() { await dispatcher?.close(); }
  };
}

export function checkUpstreamStatus(response, url, proxied) {
  const host = new URL(url).hostname;
  if (response.status === 403 || response.status === 451) {
    throw new ScraperError('UPSTREAM_FORBIDDEN', `${host}에서 서버의 접근을 거부했습니다 (HTTP ${response.status}). ${proxied ? '프록시 출구 IP에서 원문 접근이 가능한지 확인하세요.' : '해외·서버 IP 제한일 수 있습니다. 운영자는 원문에서 허용하는 국내 접속 경로를 설정하세요.'}`);
  }
  if (response.status === 429) throw new ScraperError('UPSTREAM_RATE_LIMITED', '원문 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.');
  if (response.status === 407) throw new ScraperError('PROXY_AUTH_FAILED', '프록시 인증에 실패했습니다. 서버 환경변수의 인증 정보를 확인하세요.');
  if (!response.ok) throw new ScraperError('UPSTREAM_HTTP_ERROR', `${host} 원문 응답 오류 (HTTP ${response.status})`);
}

export function checkHtmlResponse(html) {
  const text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  if (/access\s+denied|request\s+(?:was\s+)?blocked|해외\s*(?:IP|아이피|접속)[\s\S]{0,60}(?:차단|제한)|접근(?:이|을|\s)*차단|접근이\s*거부|비정상적인\s*접근|verify\s+you\s+are\s+human/i.test(text)) {
    throw new ScraperError('UPSTREAM_BLOCK_PAGE', '원문 서버가 데이터 대신 접근 차단 안내를 반환했습니다. 원문 접속 경로를 확인하세요.');
  }
}
