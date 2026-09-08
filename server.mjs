import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import iconv from 'iconv-lite';
import { createScraperTransport, validateSourceUrl, checkUpstreamStatus, checkHtmlResponse, ScraperError } from './scraper-fetch.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT || 3000);
const CACHE_TTL_MS = 60_000;
const cache = new Map();
const scraper = createScraperTransport();
const HISTORY_CACHE_TTL_MS = 24 * 60 * 60_000;
const historyCache = new Map();

const UNIVERSITY_CATALOG = [
  {
    id: 'catholic',
    name: '가톨릭대학교',
    category: '4년제 · 수시',
    provider: '진학어플라이',
    url: 'https://addon.jinhakapply.com/RatioV1/RatioH/Ratio10030381.html',
    guideUrl: 'https://apply.jinhakapply.com/Notice/1003038/A',
    updateInterval: '1시간 단위',
    parser: 'jinhak',
    encoding: 'utf-8',
    pastRatioId: '1003'
  },
  {
    id: 'far-east',
    name: '극동대학교',
    category: '4년제 · 수시',
    provider: '유웨이',
    url: 'https://ratio.uwayapply.com/Sl5KOlY5SmYlJjomSjdmVGY=',
    guideUrl: 'http://ipsi3.uwayapply.com/2027/susi2/kdu/?CHA=1',
    updateInterval: '10분 단위',
    parser: 'uway',
    encoding: 'euc-kr'
  },
  {
    id: 'gangwon',
    name: '강원대학교',
    category: '4년제 · 수시',
    provider: '유웨이',
    url: 'https://ratio.uwayapply.com/Sl5KV2FOclc4OUpmJSY6Jko3ZlRm',
    guideUrl: 'http://ipsi2.uwayapply.com/2027/susi2/kangwon/?CHA=1',
    updateInterval: '매일 5분 단위',
    parser: 'uway',
    encoding: 'euc-kr'
  },
  {
    id: 'uos',
    name: '서울시립대학교',
    category: '4년제 · 수시',
    provider: '유웨이',
    url: 'https://ratio.uwayapply.com/Sl5KJmE6SmYlJjomSjdmVGY=',
    guideUrl: 'http://ipsi3.uwayapply.com/2027/susi2/uos/?CHA=1',
    updateInterval: '매일 10·13·17시',
    parser: 'uway',
    encoding: 'euc-kr'
  }
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function cleanText(value = '') {
  return decodeEntities(
    value
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

function decodeEntities(value = '') {
  return value
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function parseNumber(value) {
  const match = String(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parseRatio(value) {
  const match = String(value).replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)\s*:\s*1/);
  return match ? Number(match[1]) : null;
}

function parseIntegerCell(value) {
  const cleaned = String(value ?? '').replace(/,/g, '').trim();
  return /^\d+(?:\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

const ALLOWED_COMPETITION_HOSTS = new Set([
  'ratio.uwayapply.com',
  'addon.jinhakapply.com'
]);

const ALLOWED_SEARCH_HOSTS = new Set(['info.uway.com']);
const ALLOWED_HISTORY_HOSTS = new Set(['apply.jinhakapply.com']);

const REGION_LABELS = new Set([
  '서울', '경기', '인천', '강원', '대전', '세종', '충남', '충북',
  '전남', '광주', '전남광주', '전북', '경남', '경북', '대구', '울산', '부산', '제주'
]);

function encodeEucKrQuery(value) {
  return [...iconv.encode(String(value), 'euc-kr')]
    .map((byte) => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`)
    .join('');
}

function normalizeCompetitionUrl(rawUrl) {
  try {
    const parsed = new URL(decodeEntities(String(rawUrl).trim()), 'https://info.uway.com/power/');
    const hostname = parsed.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(parsed.protocol) || !ALLOWED_COMPETITION_HOSTS.has(hostname)) return null;
    if (hostname === 'ratio.uwayapply.com' && parsed.pathname.replace(/\/+$/, '') === '/power') {
      const embedded = parsed.searchParams.get('ratioURL');
      if (embedded) {
        const embeddedUrl = embedded.startsWith('//') ? `https:${embedded}` : new URL(embedded, parsed).href;
        return normalizeCompetitionUrl(embeddedUrl);
      }
    }
    parsed.protocol = 'https:';
    validateSourceUrl(parsed);
    return parsed.href;
  } catch {
    return null;
  }
}

function entryFromCompetitionUrl(rawUrl, metadata = {}) {
  const url = normalizeCompetitionUrl(rawUrl);
  if (!url) return null;
  const parsed = new URL(url);
  const isJinhak = parsed.hostname === 'addon.jinhakapply.com';
  const id = metadata.id || `dynamic-${Buffer.from(url).toString('base64url')}`;
  return {
    id,
    name: metadata.name || '검색한 대학',
    category: metadata.category || '공개 경쟁률',
    provider: metadata.provider || (isJinhak ? '진학어플라이' : '유웨이'),
    url,
    updateInterval: metadata.updateInterval || '원문 안내 기준',
    parser: isJinhak ? 'jinhak' : 'uway',
    encoding: isJinhak ? 'utf-8' : 'euc-kr',
    guideUrl: metadata.guideUrl || null
  };
}

function extractPastRatioId(entry) {
  if (entry.pastRatioId) return String(entry.pastRatioId);
  if (entry.provider !== '진학어플라이' && entry.parser !== 'jinhak') return null;
  const match = String(entry.url || '').match(/(?:Ratio|Notice\/?)(\d{4})/i);
  return match ? match[1] : null;
}

function attributeValue(attributes, name) {
  const match = String(attributes).match(new RegExp(`\\b${name}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`, 'i'));
  return match ? (match[1] || match[2] || '') : '';
}

function isDateLabel(value) {
  return /\d{2,4}[./-]\d{1,2}|\d{1,2}\s*월|~/.test(value);
}

function isSearchMetaLabel(value) {
  return !value || isDateLabel(value) || REGION_LABELS.has(value) || /^(접수|예정|마감|오늘|사립|국[·ㆍ.]?공립|공립|대학원|고등학교)|(?:년제|전문대|편입학|전문대학|재외국민)/.test(value);
}

function parseUwaySearchResults(html) {
  const results = [];
  const seen = new Set();
  const rowMatches = html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const rowMatch of rowMatches) {
    const body = rowMatch[1];
    const hrefs = [...body.matchAll(/\bhref\s*=\s*(?:["']([^"']*)["']|([^\s>]+))/gi)]
      .map((match) => match[1] || match[2] || '');
    const link = hrefs.find((href) => normalizeCompetitionUrl(href));
    if (!link) continue;
    const sourceUrl = normalizeCompetitionUrl(link);
    if (!sourceUrl) continue;

    const abbrs = [...body.matchAll(/<td\b([^>]*)>/gi)]
      .map((match) => attributeValue(match[1], 'abbr'))
      .map((value) => cleanText(value))
      .filter(Boolean);
    const dateIndex = abbrs.findIndex(isDateLabel);
    const beforeDate = dateIndex >= 0 ? abbrs.slice(0, dateIndex) : abbrs;
    const candidates = beforeDate.filter((value) => !isSearchMetaLabel(value));
    const name = candidates.at(-1) || '';
    if (!name) continue;

    const category = abbrs.find((value) => /년제|전문대|편입학|대학원|고등학교|재외국민/.test(value)) || '공개 경쟁률';
    const region = abbrs.find((value) => REGION_LABELS.has(value)) || '';
    const ownership = abbrs.find((value) => /사립|국[·ㆍ.]?공립|공립/.test(value)) || '';
    const status = abbrs.find((value) => /접수|예정|마감|오늘/.test(value)) || '';
    const period = dateIndex >= 0 ? abbrs[dateIndex] : '';
    const nameLinkMatch = body.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*class=["']link["'][^>]*>([\s\S]*?)<\/a>/i);
    let guideUrl = nameLinkMatch ? nameLinkMatch[1].trim() : null;
    if (guideUrl && guideUrl.startsWith('//')) guideUrl = `https:${guideUrl}`;

    const key = `${name}|${sourceUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      id: `dynamic-${Buffer.from(sourceUrl).toString('base64url')}`,
      name,
      category,
      provider: new URL(sourceUrl).hostname === 'addon.jinhakapply.com' ? '진학어플라이' : '유웨이',
      url: sourceUrl,
      sourceUrl,
      region,
      ownership,
      status,
      period,
      guideUrl,
      supported: true
    });
  }
  return results.slice(0, 100);
}

function parseTableGrid(tableHtml) {
  const rawRows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(tableHtml))) {
    const cells = [];
    const cellRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let c;
    while ((c = cellRe.exec(tr[1]))) {
      cells.push({
        tag: c[1].toLowerCase(),
        text: cleanText(c[3]),
        colspan: Math.max(1, Math.min(50, parseInt(attributeValue(c[2], 'colspan'), 10) || 1)),
        rowspan: Math.max(1, Math.min(500, parseInt(attributeValue(c[2], 'rowspan'), 10) || 1))
      });
    }
    if (cells.length) rawRows.push(cells);
  }

  const grid = [];
  const carry = [];
  for (const rowCells of rawRows) {
    const outCells = [];
    const outTags = [];
    let col = 0;
    let ci = 0;
    const fillCarry = () => {
      while (carry[col] && carry[col].remaining > 0) {
        outCells[col] = carry[col].text;
        outTags[col] = carry[col].tag;
        carry[col].remaining -= 1;
        col += 1;
      }
    };
    while (ci < rowCells.length) {
      fillCarry();
      const cell = rowCells[ci];
      ci += 1;
      for (let k = 0; k < cell.colspan; k += 1) {
        outCells[col] = cell.text;
        outTags[col] = cell.tag;
        if (cell.rowspan > 1) carry[col] = { text: cell.text, tag: cell.tag, remaining: cell.rowspan - 1 };
        col += 1;
      }
    }
    for (let k = col; k < carry.length; k += 1) {
      if (carry[k] && carry[k].remaining > 0) {
        outCells[k] = carry[k].text;
        outTags[k] = carry[k].tag;
        carry[k].remaining -= 1;
      }
    }
    const cells = outCells.map((value) => value ?? '');
    const isHeader = outTags.length > 0 && outTags.every((tag) => tag === 'th');
    grid.push({ cells, isHeader });
  }
  return grid;
}

function isAggregateLabel(value) {
  const compact = String(value || '').replace(/\s/g, '');
  return !compact || /^(총계|소계|합계|계|전체|누계|계열소계|캠퍼스계)$/.test(compact);
}

function headerIndex(headers, pattern, { last = false, exclude = null } = {}) {
  const matches = [];
  headers.forEach((header, index) => {
    if (!header) return;
    if (exclude && exclude.test(header)) return;
    if (pattern.test(header)) matches.push(index);
  });
  if (!matches.length) return -1;
  return last ? matches[matches.length - 1] : matches[0];
}

function mapColumns(headers) {
  const ratio = headerIndex(headers, /경쟁\s*률|경쟁률|배율/);
  const seats = headerIndex(headers, /모집\s*인원|모집인원|선발\s*인원|선발인원|정원/, { exclude: /최대|누적|총\s*모집|총모집/ });
  const applicants = headerIndex(headers, /지원\s*인원|지원인원|접수\s*인원|접수인원|지원자|지원\s*현황/, { exclude: /누적/ });
  let name = headerIndex(headers, /모집단위/, { last: true, exclude: /소개|설명|안내|홈페이지|바로가기/ });
  if (name < 0) name = headerIndex(headers, /모집학과|학과명|학과|전공/, { last: true, exclude: /소개|설명|안내|홈페이지/ });
  if (name < 0) name = headerIndex(headers, /전형명|전형유형|계열|학부|구분|대학/, { last: true, exclude: /소개|설명|홈페이지/ });
  return { ratio, seats, applicants, name };
}

function isNameLike(value) {
  if (!value) return false;
  if (parseRatio(value) !== null) return false;
  if (/^[\d,\.\s:%~-]+$/.test(value)) return false;
  return true;
}

function pickName(cells, preferredIndex) {
  if (preferredIndex >= 0 && isNameLike(cells[preferredIndex])) return cells[preferredIndex];
  if (preferredIndex >= 0) {
    for (let i = preferredIndex - 1; i >= 0; i -= 1) if (isNameLike(cells[i])) return cells[i];
    for (let i = preferredIndex + 1; i < cells.length; i += 1) if (isNameLike(cells[i])) return cells[i];
  } else {
    for (const value of cells) if (isNameLike(value)) return value;
  }
  return (preferredIndex >= 0 ? cells[preferredIndex] : cells[0]) || '';
}

function rowsFromTable(tableHtml, typeId) {
  const grid = parseTableGrid(tableHtml);
  if (!grid.length) return [];

  let headerRowIndex = -1;
  for (let i = 0; i < grid.length; i += 1) {
    if (grid[i].isHeader) headerRowIndex = i;
    else if (headerRowIndex >= 0) break;
  }
  const headers = headerRowIndex >= 0 ? grid[headerRowIndex].cells : [];
  const map = mapColumns(headers);
  const hasHeaderMap = map.ratio >= 0 || map.seats >= 0 || map.applicants >= 0;

  const rows = [];
  let index = 0;
  grid.forEach((row, rowIndex) => {
    if (row.isHeader || rowIndex <= headerRowIndex) return;
    const cells = row.cells;
    if (!cells.length) return;

    let { ratio: ri, seats: si, applicants: ai, name: ni } = map;
    if (!hasHeaderMap) {
      const rIdx = cells.findIndex((cell) => parseRatio(cell) !== null);
      if (rIdx >= 1) {
        ri = rIdx;
        si = rIdx - 2 >= 0 ? rIdx - 2 : -1;
        ai = rIdx - 1;
        ni = -1;
      } else {
        ri = -1; si = -1; ai = -1; ni = -1;
        for (let i = 0; i < cells.length - 1; i += 1) {
          if (parseIntegerCell(cells[i]) !== null && parseIntegerCell(cells[i + 1]) !== null) {
            si = i;
            ai = i + 1;
            ni = i - 1;
            break;
          }
        }
      }
    }

    const name = pickName(cells, ni);
    if (isAggregateLabel(name)) return;

    const seats = si >= 0 ? parseIntegerCell(cells[si]) : null;
    const applicants = ai >= 0 ? parseIntegerCell(cells[ai]) : null;
    let ratio = ri >= 0 ? parseRatio(cells[ri]) : null;
    if (ratio === null && seats !== null && applicants !== null && seats > 0) {
      ratio = Number((applicants / seats).toFixed(2));
    }
    if (seats === null && applicants === null && ratio === null) return;

    rows.push({
      id: `${typeId}-${index}-${slug(name)}`,
      name,
      seats: seats ?? 0,
      applicants: applicants ?? 0,
      ratio
    });
    index += 1;
  });
  return rows;
}

function totalForRows(rows) {
  const seats = rows.reduce((sum, row) => sum + row.seats, 0);
  const applicants = rows.reduce((sum, row) => sum + row.applicants, 0);
  return { seats, applicants, ratio: seats ? Number((applicants / seats).toFixed(2)) : 0 };
}

function extractNotice(html) {
  const match = html.match(/경쟁률은[\s\S]{0,120}?업데이트(?:\s*됩|\s*되)[^<]{0,20}/i);
  return match ? cleanText(match[0]) : '';
}

function extractJinhakGuideUrl(html, entry) {
  const noticeMatch = html.match(/<a\b[^>]*href=["']([^"']*(?:apply\.jinhakapply\.com\/Notice\/|\/Notice\/\d+)[^"']*)["']/i)
    || html.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(?:원서접수|모집요강)/i);
  if (noticeMatch) {
    let url = noticeMatch[1].trim();
    if (url.startsWith('//')) url = `https:${url}`;
    else if (url.startsWith('/')) url = `https://apply.jinhakapply.com${url}`;
    return url;
  }
  const idMatch = String(entry?.url || '').match(/Ratio(\d{7})\d?\.html/i);
  if (idMatch) {
    return `https://apply.jinhakapply.com/Notice/${idMatch[1]}/A`;
  }
  return null;
}

function extractUwayGuideUrl(html) {
  const idMatch = html.match(/<a\b[^>]*href=['"]([^'"]+)['"][^>]*id=['"]id_gouway['"]/i)
    || html.match(/<a\b[^>]*id=['"]id_gouway['"][^>]*href=['"]([^'"]+)['"]/i);
  if (idMatch) {
    let url = idMatch[1].trim();
    if (url.startsWith('//')) url = `https:${url}`;
    return url;
  }
  const textMatch = html.match(/<a\b[^>]*href=['"]([^'"]+)['"][^>]*>(?:<b>)?(?:원서접수|모집요강)/i);
  if (textMatch) {
    let url = textMatch[1].trim();
    if (url.startsWith('//')) url = `https:${url}`;
    return url;
  }
  return null;
}

function parseJinhak(html, entry) {
  const updateMatch = html.match(/id=["']RatioTime["'][^>]*>([\s\S]*?)<\//i);
  const yearMatch = html.match(/(20\d{2})\s*학년도/);
  const titleService = cleanText(html.match(/id=["']TitleService["'][^>]*>([\s\S]*?)<\//i)?.[1] || '');
  const typeSelect = html.match(/<select\b(?=[^>]*(?:id|name)=["']selType["'])[^>]*>[\s\S]*?<\/select>/i)?.[0] || '';
  const optionTypes = new Map(
    [...typeSelect.matchAll(/<option\b[^>]*value=["']([^"']+)["'][^>]*>([\s\S]*?)<\/option>/gi)]
      .map((match) => [match[1].trim(), cleanText(match[2])])
      .filter(([id, name]) => id && id !== '0' && name && !/전체|--/.test(name) && !/^=+.*=+$/.test(name) && !/캠퍼스\s*계$/.test(name) && !isAggregateLabel(name))
  );
  const sectionMatches = [...html.matchAll(/<div\b[^>]*id=["']SelType([\w-]+)["'][^>]*>/gi)];
  const admissionTypes = [];
  const seenTypes = new Set();

  sectionMatches.forEach((section, index) => {
    const typeId = section[1];
    const start = section.index + section[0].length;
    const end = sectionMatches[index + 1]?.index ?? html.length;
    const body = html.slice(start, end);
    const headingMatch = body.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const sectionName = cleanText(headingMatch?.[1] || '').replace(/\s*경쟁률\s*현황?/g, '').trim();
    const tableMatch = body.match(/<table\b[^>]*class=["'][^"']*tableRatio3[^"']*["'][^>]*>([\s\S]*?)<\/table>/i);
    if (!tableMatch) return;
    const rows = rowsFromTable(tableMatch[1], typeId);
    admissionTypes.push({
      id: typeId,
      name: sectionName || optionTypes.get(typeId) || `전형 ${typeId}`,
      rows,
      total: totalForRows(rows)
    });
    seenTypes.add(typeId);
  });

  optionTypes.forEach((name, id) => {
    if (seenTypes.has(id)) return;
    admissionTypes.push({ id, name, rows: [], total: totalForRows([]) });
  });

  if (!admissionTypes.length) {
    const tableRe = /<table\b[^>]*class=["'][^"']*tableRatio3[^"']*["'][^>]*>([\s\S]*?)<\/table>/gi;
    let match;
    let idx = 0;
    while ((match = tableRe.exec(html))) {
      const rows = rowsFromTable(match[1], `full-${idx}`);
      idx += 1;
      if (!rows.length) continue;
      const before = html.slice(Math.max(0, match.index - 400), match.index);
      const heading = cleanText([...before.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].pop()?.[1] || '')
        .replace(/\s*경쟁률\s*현황?/g, '').replace(/경쟁률/g, '').replace(/전체|모집단위별/g, '').trim();
      admissionTypes.push({ id: `full-${idx - 1}`, name: heading || titleService || '경쟁률 현황', rows, total: totalForRows(rows) });
    }
    admissionTypes.forEach((type) => {
      if (admissionTypes.filter((other) => other.name === type.name).length > 1) {
        type.name = `${type.name} (${type.id.replace('full-', '')})`;
      }
    });
  }

  if (!admissionTypes.length) {
    const summaryRe = /<table\b[^>]*class=["'][^"']*tableRatio[^"']*["'][^>]*>([\s\S]*?)<\/table>/gi;
    let match;
    while ((match = summaryRe.exec(html))) {
      const rows = rowsFromTable(match[1], 'summary');
      if (!rows.length) continue;
      const before = html.slice(Math.max(0, match.index - 300), match.index);
      const heading = cleanText([...before.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].pop()?.[1] || '')
        .replace(/\s*경쟁률\s*현황?/g, '').replace(/경쟁률/g, '').trim();
      admissionTypes.push({ id: 'summary', name: heading || titleService || '전형별 경쟁률', rows, total: totalForRows(rows) });
      break;
    }
  }

  return {
    year: yearMatch?.[1] || '',
    updatedAt: cleanText(updateMatch?.[1] || ''),
    note: extractNotice(html),
    guideUrl: extractJinhakGuideUrl(html, entry),
    admissionTypes
  };
}

function parseUway(html, entry) {
  const optionMatches = [...html.matchAll(/<option\b[^>]*value=['"]([^'"]*)['"][^>]*>([\s\S]*?)<\/option>/gi)];
  const options = new Map(
    optionMatches
      .map((match) => [match[1].trim(), cleanText(match[2])])
      .filter(([id, name]) => id && name && !/전체|전\s*체|--/.test(name) && !/캠퍼스\s*계$/.test(name) && !isAggregateLabel(name))
  );
  if (!options.size) {
    const summaryRows = [...html.matchAll(/<tr\b[^>]*id=['"]Tr_([\w-]+)_0['"][^>]*>([\s\S]*?)<\/tr>/gi)];
    summaryRows.forEach((summary) => {
      const cells = [...summary[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cleanText(cell[1]));
      const typeId = summary[1];
      const name = cells.find((cell) => cell && parseIntegerCell(cell) === null && parseRatio(cell) === null);
      if (typeId && name && !isAggregateLabel(name)) options.set(typeId, name);
    });
  }
  const markers = [...html.matchAll(/<span\b[^>]*id=['"]strTitleId_([\w-]+)['"][^>]*>([\s\S]*?)<\/span>/gi)];
  const admissionTypes = [];
  const seenTypes = new Set();

  markers.forEach((marker, index) => {
    const typeId = marker[1];
    if (/Stat$/i.test(typeId)) return;
    const titleText = cleanText(marker[2]).replace(/\s*경쟁률\s*현황?/g, '').trim();
    const start = marker.index + marker[0].length;
    const end = markers[index + 1]?.index ?? html.length;
    const body = html.slice(start, end);
    const tableMatch = body.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i);
    const rows = tableMatch ? rowsFromTable(tableMatch[1], typeId) : [];
    const name = options.get(typeId) || titleText || `전형 ${typeId}`;
    if (isAggregateLabel(name)) return;
    admissionTypes.push({ id: typeId, name, rows, total: totalForRows(rows) });
    seenTypes.add(typeId);
  });

  options.forEach((name, id) => {
    if (seenTypes.has(id) || isAggregateLabel(name)) return;
    admissionTypes.push({ id, name, rows: [], total: totalForRows([]) });
  });

  if (!admissionTypes.length) {
    const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
    let match;
    let idx = 0;
    while ((match = tableRe.exec(html))) {
      const rows = rowsFromTable(match[1], `t-${idx}`);
      idx += 1;
      if (!rows.length) continue;
      const before = html.slice(Math.max(0, match.index - 600), match.index);
      const heading = cleanText([...before.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>|<span[^>]*class=['"][^'"]*(?:bul|btext[rb])[^'"]*['"][^>]*>([\s\S]*?)<\/span>/gi)]
        .map((entry) => entry[1] || entry[2]).filter(Boolean).pop() || '')
        .replace(/\s*경쟁률\s*현황?/g, '').replace(/경쟁률/g, '').trim();
      admissionTypes.push({ id: `t-${idx - 1}`, name: heading || '경쟁률 현황', rows, total: totalForRows(rows) });
    }
  }

  const updatedMatch = html.match(/id=['"]ID_DateStr['"][^>]*>[\s\S]*?<label[^>]*>([\s\S]*?)<\//i);
  const yearMatch = html.match(/(20\d{2})\s*학년도/);
  return {
    year: yearMatch?.[1] || '',
    updatedAt: cleanText(updatedMatch?.[1] || ''),
    note: extractNotice(html),
    guideUrl: extractUwayGuideUrl(html),
    admissionTypes
  };
}

const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const cookieJar = new Map();

function parseCookieString(str) {
  const cookies = new Map();
  if (!str) return cookies;

  const lines = String(str).split(/\r?\n/);
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    if (trimmedLine.includes('\t')) {
      const cols = trimmedLine.split('\t').map((c) => c.trim()).filter(Boolean);
      if (cols.length >= 2) {
        const [name, val] = cols;
        if (name.toLowerCase() !== 'name') {
          cookies.set(name, val);
          continue;
        }
      }
    }

    for (const part of trimmedLine.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        cookies.set(key, val);
      }
    }
  }

  return cookies;
}

function loadEnvCookie() {
  const envCookie = process.env.UWAY_COOKIE || process.env.COOKIE || '';
  if (!envCookie) return;
  const parsed = parseCookieString(envCookie);
  const targetDomains = [
    'uway.com',
    'info.uway.com',
    'uwayapply.com',
    'ratio.uwayapply.com'
  ];
  for (const domain of targetDomains) {
    if (!cookieJar.has(domain)) cookieJar.set(domain, new Map());
    const m = cookieJar.get(domain);
    for (const [k, v] of parsed) {
      m.set(k, v);
    }
  }
}

loadEnvCookie();

function storeCookies(hostname, setCookieHeaders) {
  if (!setCookieHeaders) return;
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const raw of list) {
    if (!raw) continue;
    const [cookiePair, ...directives] = raw.split(';');
    const eqIdx = cookiePair.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = cookiePair.slice(0, eqIdx).trim();
    const value = cookiePair.slice(eqIdx + 1).trim();

    let targetDomain = hostname.toLowerCase();
    for (const dir of directives) {
      const [dName, dVal] = dir.split('=').map((s) => s.trim().toLowerCase());
      if (dName === 'domain' && dVal) {
        targetDomain = dVal.replace(/^\./, '');
      }
    }
    if (hostname !== targetDomain && !hostname.endsWith(`.${targetDomain}`)) continue;
    if (!['uway.com', 'info.uway.com', 'uwayapply.com', 'ratio.uwayapply.com', 'jinhakapply.com', 'addon.jinhakapply.com'].includes(targetDomain)) continue;
    if (!cookieJar.has(targetDomain)) {
      cookieJar.set(targetDomain, new Map());
    }
    cookieJar.get(targetDomain).set(name, value);
  }
}

function getCookiesForHost(hostname) {
  const host = hostname.toLowerCase();
  const result = new Map();

  const envCookie = host === 'addon.jinhakapply.com'
    ? process.env.JINHAK_COOKIE || ''
    : process.env.UWAY_COOKIE || process.env.COOKIE || '';
  if (envCookie) {
    for (const [k, v] of parseCookieString(envCookie)) {
      result.set(k, v);
    }
  }

  for (const [domain, cookies] of cookieJar.entries()) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      for (const [k, v] of cookies) {
        result.set(k, v);
      }
    }
  }

  if (result.size === 0) return '';
  return [...result.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

const warmedHosts = new Set();
async function ensureSession(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname.toLowerCase();
    if (warmedHosts.has(host)) return;

    const originUrl = `${parsed.protocol}//${parsed.hostname}/`;
    const headers = {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      'User-Agent': USER_AGENT,
      'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1'
    };
    const cookieHeader = getCookiesForHost(host);
    if (cookieHeader) headers.Cookie = cookieHeader;

    const response = await scraper.fetch(originUrl, {
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(8_000)
    });
    const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : response.headers.get('set-cookie');
    if (setCookies) {
      storeCookies(host, setCookies);
    }
    await response.body?.cancel();
    if (response.ok || (response.status >= 300 && response.status < 400)) warmedHosts.add(host);
  } catch {}
}

async function fetchHtml(url, encoding, allowedHosts = new Set([...ALLOWED_COMPETITION_HOSTS, ...ALLOWED_SEARCH_HOSTS])) {
  let currentUrl = validateSourceUrl(url, allowedHosts).href;
  await ensureSession(currentUrl);

  for (let hop = 0; hop <= 3; hop += 1) {
    const current = validateSourceUrl(currentUrl, allowedHosts);

    const headers = {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      'User-Agent': USER_AGENT,
      'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      Referer: `${current.origin}/`
    };

    const cookieHeader = getCookiesForHost(current.hostname);
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    const response = await scraper.fetch(current, {
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(15_000)
    });

    const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : response.headers.get('set-cookie');
    if (setCookies) {
      storeCookies(current.hostname, setCookies);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || hop === 3) throw new Error('원문 리다이렉트가 너무 많습니다.');
      currentUrl = new URL(location, current).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      checkUpstreamStatus(response, current, scraper.usesProxy(current.hostname));
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    let html;
    try {
      html = new TextDecoder(encoding).decode(buffer);
    } catch {
      html = new TextDecoder('utf-8').decode(buffer);
    }
    checkHtmlResponse(html);
    return html;
  }
  throw new Error('원문을 읽지 못했습니다.');
}

async function searchUwayUniversities(query) {
  const trimmed = String(query || '').trim().slice(0, 80);
  if (trimmed.length < 2) throw new Error('대학명은 두 글자 이상 입력하세요.');
  const searchUrl = `https://info.uway.com/power/?v_mode=school_nm_view&R_SearchText=${encodeEucKrQuery(trimmed)}`;
  const html = await fetchHtml(searchUrl, 'euc-kr', ALLOWED_SEARCH_HOSTS);
  if (!/<table\b/i.test(html) || !/학교명|대학명|경쟁률|검색결과|검색\s*결과/.test(html)) {
    throw new ScraperError('UPSTREAM_FORMAT_CHANGED', '대학 검색 원문의 형식을 확인할 수 없습니다. 접근 제한 또는 원문 변경 여부를 확인하세요.');
  }
  return parseUwaySearchResults(html);
}

async function readCompetition(entry) {
  const html = await fetchHtml(entry.url, entry.encoding, new Set([new URL(entry.url).hostname]));
  const parsed = entry.parser === 'jinhak' ? parseJinhak(html, entry) : parseUway(html, entry);
  if (!parsed.admissionTypes.length) throw new Error(`${entry.name}의 전형 표를 찾지 못했습니다.`);
  const guideUrl = parsed.guideUrl || entry.guideUrl || null;
  return {
    id: entry.id,
    university: entry.name,
    year: parsed.year,
    updatedAt: parsed.updatedAt,
    note: parsed.note || `${entry.provider} 공개 페이지 기준 경쟁률입니다.`,
    guideUrl,
    admissionTypes: parsed.admissionTypes,
    source: {
      url: entry.url,
      provider: entry.provider,
      updateInterval: entry.updateInterval,
      guideUrl,
      portalUrl: 'https://info.uway.com/power/'
    },
    fetchedAt: new Date().toISOString(),
    live: true
  };
}

function parsePastRatio(html, year) {
  const hdnMatch = html.match(/id=["']hdnResult["'][^>]*value=["']([^"']+)["']/i);
  if (hdnMatch) {
    try {
      const raw = decodeEntities(hdnMatch[1]);
      const json = JSON.parse(raw);
      const cols = json.Columns || [];
      const majorIdx = cols.indexOf('MajorName');
      const selTypeIdx = cols.indexOf('SelTypeName');
      const mojipIdx = cols.indexOf('Mojip');
      const jiwonIdx = cols.indexOf('Jiwon');
      const ratioIdx = cols.indexOf('Ratio');

      const typeMap = new Map();
      (json.Rows || []).forEach((row, i) => {
        const typeName = selTypeIdx >= 0 ? String(row[selTypeIdx] || '일반전형') : '일반전형';
        if (!typeMap.has(typeName)) typeMap.set(typeName, []);
        const name = majorIdx >= 0 ? String(row[majorIdx] || '') : '';
        const seats = mojipIdx >= 0 ? Number(row[mojipIdx]) || 0 : 0;
        const applicants = jiwonIdx >= 0 ? Number(row[jiwonIdx]) || 0 : 0;
        const ratio = ratioIdx >= 0 && row[ratioIdx] !== null && row[ratioIdx] !== undefined
          ? Number(Number(row[ratioIdx]).toFixed(2))
          : (seats > 0 ? Number((applicants / seats).toFixed(2)) : 0);

        typeMap.get(typeName).push({
          id: `past-${i}-${slug(name)}`,
          name,
          seats,
          applicants,
          ratio
        });
      });

      const admissionTypes = [];
      let typeIndex = 0;
      for (const [name, rows] of typeMap.entries()) {
        admissionTypes.push({
          id: `past-type-${typeIndex++}`,
          name,
          rows,
          total: totalForRows(rows)
        });
      }
      return { year: String(year || ''), admissionTypes };
    } catch {}
  }

  const yearMatch = html.match(/(20\d{2})\s*학년도/);
  const admissionTypes = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let match;
  let idx = 0;
  while ((match = tableRe.exec(html))) {
    const rows = rowsFromTable(match[1], `past-${idx}`);
    idx += 1;
    if (!rows.length) continue;
    const before = html.slice(Math.max(0, match.index - 500), match.index);
    const heading = cleanText([...before.matchAll(/<(?:h[1-4]|strong|b|caption)[^>]*>([\s\S]*?)<\/(?:h[1-4]|strong|b|caption)>/gi)]
      .map((e) => e[1]).filter(Boolean).pop() || '')
      .replace(/\s*경쟁률\s*현황?/g, '').replace(/경쟁률/g, '').replace(/전체|모집단위별|최종/g, '').trim();
    admissionTypes.push({ id: `past-${idx - 1}`, name: heading || '경쟁률 현황', rows, total: totalForRows(rows) });
  }
  return { year: yearMatch?.[1] || String(year || ''), admissionTypes };
}

async function readPastCompetition(pastRatioId, year, category) {
  const cacheKey = `past:${pastRatioId}:${year}:${category}`;
  const cached = historyCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < HISTORY_CACHE_TTL_MS) return cached.payload;

  const url = `https://apply.jinhakapply.com/SmartRatio/PastRatioUniv?univid=${encodeURIComponent(pastRatioId)}&year=${encodeURIComponent(year)}&category=${encodeURIComponent(category)}`;
  const html = await fetchHtml(url, 'utf-8', ALLOWED_HISTORY_HOSTS);
  const parsed = parsePastRatio(html, year);
  const payload = {
    year: parsed.year || String(year),
    admissionTypes: parsed.admissionTypes,
    source: 'jinhakapply-past',
    fetchedAt: new Date().toISOString()
  };
  historyCache.set(cacheKey, { cachedAt: Date.now(), payload });
  return payload;
}

function parseUwayPastRatio(html, year) {
  const tableMatch = html.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return { year: String(year || ''), admissionTypes: [] };

  const trs = [...tableMatch[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (trs.length < 2) return { year: String(year || ''), admissionTypes: [] };

  const typeMap = new Map();
  let rowIndex = 0;

  for (let i = 1; i < trs.length; i++) {
    const cells = [...trs[i][1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((m) => cleanText(m[1]));
    if (cells.length < 9) continue;

    const admissionName = cells[4] || '일반전형';
    const deptName = cells[5] || '';
    const seats = parseIntegerCell(cells[6]) ?? 0;
    const applicants = parseIntegerCell(cells[7]) ?? 0;
    const ratio = parseRatio(cells[8]) ?? (seats > 0 ? Number((applicants / seats).toFixed(2)) : 0);

    if (!typeMap.has(admissionName)) {
      typeMap.set(admissionName, []);
    }

    typeMap.get(admissionName).push({
      id: `uway-past-${rowIndex++}-${slug(deptName)}`,
      name: deptName,
      seats,
      applicants,
      ratio
    });
  }

  const admissionTypes = [];
  let typeIdx = 0;
  for (const [name, rows] of typeMap.entries()) {
    admissionTypes.push({
      id: `uway-type-${typeIdx++}`,
      name,
      rows,
      total: totalForRows(rows)
    });
  }

  return { year: String(year || ''), admissionTypes };
}

async function readUwayPastCompetition(univName, year) {
  const cleanName = String(univName || '').replace(/\(.*?\)/g, '').trim();
  const cacheKey = `uway-past:${cleanName}:${year}`;
  const cached = historyCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < HISTORY_CACHE_TTL_MS) return cached.payload;

  const encName = encodeEucKrQuery(cleanName);
  const url = `https://info.uway.com/power/?v_mode=last_ratio_view&o_year=${encodeURIComponent(year)}&R_SearchText=${encName}`;
  const html = await fetchHtml(url, 'euc-kr', ALLOWED_SEARCH_HOSTS);
  const parsed = parseUwayPastRatio(html, year);
  const payload = {
    year: parsed.year || String(year),
    admissionTypes: parsed.admissionTypes,
    source: 'uwayapply-past',
    fetchedAt: new Date().toISOString()
  };
  historyCache.set(cacheKey, { cachedAt: Date.now(), payload });
  return payload;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

async function handleApi(url, response) {
  if (url.pathname === '/api/health') {
    sendJson(response, 200, { status: 'ok', scraper: scraper.status });
    return true;
  }
  if (url.pathname === '/api/universities' || url.pathname === '/api/universities/search') {
    const query = (url.searchParams.get('q') || '').trim();
    if (!query) {
      sendJson(response, 200, []);
      return true;
    }
    try {
      const results = await searchUwayUniversities(query);
      sendJson(response, 200, results);
    } catch (error) {
      sendJson(response, query.length < 2 ? 400 : 502, { error: error.message || '대학 검색에 실패했습니다.', code: error.code || 'SEARCH_FAILED' });
    }
    return true;
  }

  if (url.pathname === '/api/competition/history') {
    const id = url.searchParams.get('university');
    const sourceUrl = url.searchParams.get('url') || url.searchParams.get('sourceUrl');
    const year = url.searchParams.get('year');
    const category = url.searchParams.get('category') || '1';
    if (!year || !/^20\d{2}$/.test(year)) {
      sendJson(response, 400, { error: '올바른 학년도(예: 2025)를 입력하세요.' });
      return true;
    }
    const nameParam = url.searchParams.get('name') || '';
    const catalogEntry = UNIVERSITY_CATALOG.find((item) => item.id === id || item.name === id || (nameParam && item.name === nameParam));
    const entry = catalogEntry || entryFromCompetitionUrl(sourceUrl, { id, name: nameParam || undefined, provider: url.searchParams.get('provider') || undefined });
    if (!entry) {
      sendJson(response, 400, { error: '대학 정보를 찾을 수 없습니다.', code: 'INVALID_UNIVERSITY' });
      return true;
    }

    const isJinhak = entry.provider === '진학어플라이' || entry.parser === 'jinhak' || String(entry.url || '').includes('jinhakapply.com');
    const isUway = entry.provider === '유웨이' || entry.parser === 'uway' || String(entry.url || '').includes('uwayapply.com') || String(entry.url || '').includes('uway.com');

    try {
      if (isJinhak) {
        const pastRatioId = extractPastRatioId(entry);
        if (!pastRatioId) {
          sendJson(response, 400, { error: '이 대학은 과거 경쟁률 코드를 찾을 수 없습니다.', code: 'NO_HISTORY' });
          return true;
        }
        const payload = await readPastCompetition(pastRatioId, year, category);
        sendJson(response, 200, payload);
        return true;
      } else if (isUway) {
        const univName = entry.name;
        if (!univName || univName === '검색한 대학') {
          sendJson(response, 400, { error: '대학명을 알 수 없어 과거 경쟁률을 조회할 수 없습니다.', code: 'NO_HISTORY' });
          return true;
        }
        const payload = await readUwayPastCompetition(univName, year);
        sendJson(response, 200, payload);
        return true;
      } else {
        sendJson(response, 400, { error: '이 대학은 아직 과거 경쟁률 비교를 지원하지 않습니다.', code: 'NO_HISTORY' });
        return true;
      }
    } catch (error) {
      sendJson(response, 502, { error: error.message || '과거 경쟁률을 불러오지 못했습니다.', code: error.code || 'HISTORY_FAILED' });
      return true;
    }
  }

  if (url.pathname !== '/api/competition') return false;
  const id = url.searchParams.get('university');
  const sourceUrl = url.searchParams.get('url') || url.searchParams.get('sourceUrl');
  const catalogEntry = UNIVERSITY_CATALOG.find((item) => item.id === id);
  const entry = catalogEntry || entryFromCompetitionUrl(sourceUrl, {
    id,
    name: url.searchParams.get('name') || undefined,
    category: url.searchParams.get('category') || undefined,
    provider: url.searchParams.get('provider') || undefined,
    guideUrl: url.searchParams.get('guideUrl') || undefined
  });
  if (!entry) {
    sendJson(response, 400, { error: '지원하지 않는 경쟁률 상세 URL입니다.' });
    return true;
  }

  const forceRefresh = url.searchParams.has('refresh');
  const cacheKey = entry.url;
  const cached = cache.get(cacheKey);
  if (cached && !forceRefresh && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    sendJson(response, 200, { ...cached.payload, cacheHit: true, cacheAgeSeconds: Math.floor((Date.now() - cached.cachedAt) / 1000) });
    return true;
  }

  try {
    const payload = await readCompetition(entry);
    cache.set(cacheKey, { cachedAt: Date.now(), payload });
    sendJson(response, 200, payload);
  } catch (error) {
    if (cached) {
      sendJson(response, 200, {
        ...cached.payload,
        live: false,
        stale: true,
        warning: error.message,
        cacheAgeSeconds: Math.floor((Date.now() - cached.cachedAt) / 1000)
      });
      return true;
    }
    sendJson(response, 502, { error: error.message || '공개 원문을 읽지 못했습니다.', code: error.code || 'FETCH_FAILED' });
  }
  return true;
}

async function serveStatic(pathname, response) {
  const relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
  if (!new Set(['index.html', 'app.js', 'styles.css']).has(relativePath)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }
  const filePath = resolve(ROOT, relativePath);
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${sep}`)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('Not a file');
    const content = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    response.end(content);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
  }
}

export const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method Not Allowed');
    return;
  }
  if (request.method === 'HEAD') {
    response.writeHead(204);
    response.end();
    return;
  }
  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(url, response);
      if (!handled) sendJson(response, 404, { error: 'API route not found' });
      return;
    }
    await serveStatic(url.pathname, response);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) sendJson(response, 500, { error: '서버 내부 오류' });
  }
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => {
    console.log(`RATIO dashboard running at http://localhost:${PORT}`);
    console.log(`Scraper proxy configured: ${scraper.status.proxyConfigured}; hosts: ${scraper.status.proxyHosts.join(',') || 'direct'}`);
  });
}
