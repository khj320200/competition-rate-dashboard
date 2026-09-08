'use strict';

const WATCH_KEY = 'ratio-watchlist-v1';
const numberFormat = new Intl.NumberFormat('ko-KR');
const HISTORY_YEARS = [2026, 2025, 2024];

const state = {
  catalog: [],
  searchResults: [],
  data: null,
  university: null,
  admissionId: '',
  departmentId: '',
  watchlist: [],
  loading: false,
  historyOpen: new Set(),
  historyData: new Map()
};

const $ = (id) => document.getElementById(id);
const dom = {};

function formatCount(value) {
  return numberFormat.format(Number(value) || 0);
}

function formatRatio(value) {
  if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return '-';
  return `${Number(value).toFixed(2)} : 1`;
}

function setStatus(message, isError) {
  dom.status.textContent = message || '';
  dom.status.classList.toggle('error', Boolean(isError));
}

function staleWarning(data) {
  if (!data?.stale && data?.live !== false) return '';
  return data.warning || '최신 경쟁률을 불러오지 못해 이전에 수집한 데이터를 표시합니다.';
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload;
}

function normalize(data) {
  const admissionTypes = (data?.admissionTypes || []).map((type) => {
    const rows = (type.rows || []).map((row, i) => {
      const parsed = Number(row.ratio);
      return {
        id: row.id || `${type.id}-${i}`,
        name: row.name || '',
        seats: Number(row.seats) || 0,
        applicants: Number(row.applicants) || 0,
        ratio: row.ratio === null || row.ratio === undefined || Number.isNaN(parsed) ? null : parsed
      };
    });
    return { id: type.id, name: type.name, rows };
  });
  return { ...data, admissionTypes };
}

function currentType() {
  return state.data?.admissionTypes?.find((type) => type.id === state.admissionId) || null;
}

function currentRow() {
  return currentType()?.rows?.find((row) => row.id === state.departmentId) || null;
}


function renderUniversityResults(message) {
  dom.universityResults.replaceChildren();
  if (message || state.searchResults.length === 0) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'empty';
    span.textContent = message || '검색 결과가 없습니다.';
    li.append(span);
    dom.universityResults.append(li);
    dom.universityResults.hidden = false;
    return;
  }
  state.searchResults.forEach((uni) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = uni.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = [uni.category, uni.region, uni.provider, uni.status].filter(Boolean).join(' · ');
    button.append(meta);
    button.addEventListener('click', () => selectUniversity(uni));
    li.append(button);
    dom.universityResults.append(li);
  });
  dom.universityResults.hidden = false;
}

async function searchUniversities() {
  const query = dom.universityQuery.value.trim();
  if (query.length < 2) {
    renderUniversityResults('대학명을 두 글자 이상 입력하세요.');
    return;
  }
  setStatus(`"${query}" 검색 중...`);
  dom.universitySearchButton.disabled = true;
  try {
    const results = await fetchJson(`/api/universities/search?q=${encodeURIComponent(query)}`);
    state.searchResults = Array.isArray(results) ? results : [];
    renderUniversityResults();
    setStatus(state.searchResults.length ? `${state.searchResults.length}개 대학을 찾았습니다. 선택하세요.` : '검색 결과가 없습니다.', !state.searchResults.length);
  } catch (error) {
    state.searchResults = [];
    renderUniversityResults(error.message || '검색에 실패했습니다.');
    setStatus(`검색 실패: ${error.message}`, true);
  } finally {
    dom.universitySearchButton.disabled = false;
  }
}

async function selectUniversity(uni) {
  state.university = uni;
  state.searchResults = [];
  dom.universityResults.hidden = true;
  dom.universityQuery.value = uni.name;
  dom.currentUniversity.textContent = `${uni.name} · ${uni.provider || '공개 경쟁률'}`;
  setStatus(`${uni.name} 경쟁률을 불러오는 중...`);
  dom.departmentQuery.disabled = true;
  dom.addButton.disabled = true;
  dom.selectionInfo.textContent = '';

  const params = new URLSearchParams();
  const isCatalog = state.catalog.some((item) => item.id === uni.id && !String(uni.id).startsWith('dynamic-'));
  if (isCatalog) {
    params.set('university', uni.id);
  } else {
    params.set('url', uni.url || '');
    params.set('name', uni.name || '');
    if (uni.provider) params.set('provider', uni.provider);
  }

  try {
    const data = normalize(await fetchJson(`/api/competition?${params.toString()}`));
    if (!data.admissionTypes.length) throw new Error('공개된 경쟁률 표가 없습니다.');
    state.data = data;
    state.admissionId = '';
    state.departmentId = '';
    dom.departmentQuery.value = '';
    dom.departmentQuery.disabled = false;
    dom.departmentResults.hidden = true;
    dom.selectionInfo.textContent = '';
    updateAddButton();
    const warning = staleWarning(data);
    setStatus(warning
      ? `${uni.name}: ${warning}${data.updatedAt ? ` · 원문 갱신: ${data.updatedAt}` : ''}`
      : `${uni.name} 연동 완료${data.updatedAt ? ` · ${data.updatedAt}` : ''}.`, Boolean(warning));
  } catch (error) {
    state.data = null;
    state.admissionId = '';
    state.departmentId = '';
    dom.selectionInfo.textContent = '';
    dom.departmentQuery.disabled = true;
    updateAddButton();
    setStatus(`${uni.name}: ${error.message}`, true);
  }
}


function renderDepartmentResults() {
  const query = dom.departmentQuery.value.trim().toLocaleLowerCase('ko-KR');
  dom.departmentResults.replaceChildren();
  if (!query || !state.data) {
    dom.departmentResults.hidden = true;
    return;
  }
  const matches = [];
  state.data.admissionTypes.forEach((type) => {
    type.rows.forEach((row) => {
      if (row.name.toLocaleLowerCase('ko-KR').includes(query)) matches.push({ type, row });
    });
  });
  if (!matches.length) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'empty';
    span.textContent = '일치하는 학과가 없습니다.';
    li.append(span);
    dom.departmentResults.append(li);
    dom.departmentResults.hidden = false;
    return;
  }
  matches.slice(0, 200).forEach(({ type, row }) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = row.name;
    const rate = document.createElement('span');
    rate.className = 'rate';
    rate.textContent = formatRatio(row.ratio);
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = type.name;
    button.append(rate, meta);
    button.addEventListener('click', () => {
      selectDepartment(type.id, row.id);
      dom.departmentResults.hidden = true;
    });
    li.append(button);
    dom.departmentResults.append(li);
  });
  dom.departmentResults.hidden = false;
}

function selectDepartment(admissionId, departmentId) {
  state.admissionId = admissionId;
  state.departmentId = departmentId;
  updateAddButton();
  const row = currentRow();
  const type = currentType();
  if (row && type) {
    dom.selectionInfo.textContent = `선택: ${type.name} · ${row.name} · ${formatRatio(row.ratio)}`;
  }
}


function watchKey(row, type) {
  return `${state.data?.source?.url || state.university?.url || state.university?.id}::${type.id}::${row.id}`;
}

function updateAddButton() {
  const row = currentRow();
  const type = currentType();
  if (!row || !type) {
    dom.addButton.disabled = true;
    dom.addButton.textContent = '관심 목록에 추가';
    return;
  }
  const exists = state.watchlist.some((item) => item.key === watchKey(row, type));
  dom.addButton.disabled = exists;
  dom.addButton.textContent = exists ? '이미 추가됨' : '관심 목록에 추가';
}

function getGuideUrl(item) {
  if (item.guideUrl) return item.guideUrl;
  if (item.sourceUrl) {
    const jinhakMatch = item.sourceUrl.match(/Ratio(\d{7})\d?\.html/i);
    if (jinhakMatch) return `https://apply.jinhakapply.com/Notice/${jinhakMatch[1]}/A`;
  }
  const query = encodeURIComponent(`${item.university} 모집요강`);
  return `https://search.naver.com/search.naver?query=${query}`;
}

function addCurrent() {
  const row = currentRow();
  const type = currentType();
  if (!row || !type || !state.data) return;
  const key = watchKey(row, type);
  if (state.watchlist.some((item) => item.key === key)) return;
  const source = state.data.source || {};
  const warning = staleWarning(state.data);
  const guideUrl = state.data.guideUrl || state.data.source?.guideUrl || state.university?.guideUrl || '';
  state.watchlist.unshift({
    key,
    university: state.data.university || state.university?.name || '',
    admissionId: type.id,
    admission: type.name,
    departmentId: row.id,
    department: row.name,
    seats: row.seats,
    applicants: row.applicants,
    ratio: row.ratio,
    sourceUrl: source.url || state.university?.url || '',
    provider: source.provider || state.university?.provider || '',
    providerUpdatedAt: state.data.updatedAt || '',
    providerUpdateInterval: source.updateInterval || '',
    providerNote: state.data.note || '',
    guideUrl,
    refreshedAt: state.data.fetchedAt || (warning ? '' : new Date().toISOString()),
    refreshError: warning
  });
  saveWatchlist();
  renderWatchlist();
  updateAddButton();
  if (warning) setStatus(`이전에 수집한 데이터를 관심 목록에 추가했습니다. ${warning}`, true);
}

function removeWatch(key) {
  state.watchlist = state.watchlist.filter((item) => item.key !== key);
  saveWatchlist();
  renderWatchlist();
  updateAddButton();
}

function loadWatchlist() {
  try {
    const saved = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
    state.watchlist = Array.isArray(saved) ? saved : [];
  } catch {
    state.watchlist = [];
  }
}

function saveWatchlist() {
  try { localStorage.setItem(WATCH_KEY, JSON.stringify(state.watchlist)); } catch {}
}

function formatYearMonthDayHour(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}.${pad(date.getHours())}`;
}

function parseProviderDateTime(value) {
  const text = String(value ?? '').replace(/\u00a0/g, ' ').trim();
  if (!text) return null;

  const dateMatch = text.match(/(20\d{2})\s*(?:년|[./-])\s*(\d{1,2})\s*(?:월|[./-])\s*(\d{1,2})\s*(?:일)?/);
  const timeMatch = text.match(/(오전|오후)?\s*(\d{1,2})\s*(?::|시)\s*(\d{1,2})(?:\s*분)?/);
  if (dateMatch && timeMatch) {
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    let hour = Number(timeMatch[2]);
    const minute = Number(timeMatch[3]);
    const period = timeMatch[1];
    if (period && (hour < 1 || hour > 12)) return null;
    if (!period && (hour < 0 || hour > 23)) return null;
    if (period === '오후' && hour < 12) hour += 12;
    if (period === '오전' && hour === 12) hour = 0;
    if (minute > 59) return null;

    const date = new Date(year, month - 1, day, hour, minute);
    if (
      date.getFullYear() !== year
      || date.getMonth() !== month - 1
      || date.getDate() !== day
      || date.getHours() !== hour
      || date.getMinutes() !== minute
    ) return null;
    return date;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatProviderUpdatedAt(value) {
  const date = parseProviderDateTime(value);
  return date ? formatYearMonthDayHour(date) : '';
}


function findHistoryMatch(data, item) {
  if (!data?.admissionTypes) return null;
  const cleanTarget = item.department.replace(/\s/g, '');
  // 1. Exact match in matching admission type
  for (const type of data.admissionTypes) {
    if (item.admission && (type.name.includes(item.admission) || item.admission.includes(type.name))) {
      for (const row of type.rows || []) {
        if (row.name === item.department || row.name.replace(/\s/g, '') === cleanTarget) {
          return { type, row };
        }
      }
    }
  }
  // 2. Exact match across all types
  for (const type of data.admissionTypes) {
    for (const row of type.rows || []) {
      if (row.name === item.department || row.name.replace(/\s/g, '') === cleanTarget) {
        return { type, row };
      }
    }
  }
  // 3. Substring match
  for (const type of data.admissionTypes) {
    for (const row of type.rows || []) {
      const cleanRow = row.name.replace(/\s/g, '');
      if (cleanRow && cleanTarget && (cleanRow.includes(cleanTarget) || cleanTarget.includes(cleanRow))) {
        return { type, row };
      }
    }
  }
  // 4. Base name match (strip parentheses and 학과/학부/전공 suffixes)
  const baseTarget = cleanTarget.replace(/\(.*?\)/g, '').replace(/학과|학부|전공/g, '');
  if (baseTarget.length >= 2) {
    for (const type of data.admissionTypes) {
      for (const row of type.rows || []) {
        const baseRow = row.name.replace(/\s/g, '').replace(/\(.*?\)/g, '').replace(/학과|학부|전공/g, '');
        if (baseRow && (baseRow === baseTarget || baseRow.includes(baseTarget) || baseTarget.includes(baseRow))) {
          return { type, row };
        }
      }
    }
  }
  return null;
}

async function fetchHistory(item) {
  const results = [];
  for (const year of HISTORY_YEARS) {
    const cacheKey = `${item.sourceUrl || item.university}:${year}`;
    if (state.historyData.has(cacheKey)) {
      results.push({ year, ...state.historyData.get(cacheKey) });
      continue;
    }
    try {
      const params = new URLSearchParams({
        url: item.sourceUrl || '',
        name: item.university || '',
        provider: item.provider || '',
        year: String(year),
        category: '1'
      });
      const data = await fetchJson(`/api/competition/history?${params.toString()}`);
      const match = findHistoryMatch(data, item);
      const entry = match
        ? { found: true, seats: match.row.seats, applicants: match.row.applicants, ratio: match.row.ratio, admission: match.type.name, department: match.row.name }
        : { found: false, error: '해당 모집단위를 찾지 못했습니다.' };
      state.historyData.set(cacheKey, entry);
      results.push({ year, ...entry });
    } catch (error) {
      const entry = { found: false, error: error.message || '과거 데이터 조회 실패' };
      if (error.message && /NO_HISTORY|지원하지 않/.test(error.message)) {
        state.historyData.set(cacheKey, entry);
      }
      results.push({ year, ...entry });
    }
  }
  return results;
}

function formatDelta(current, past) {
  if (current === null || current === undefined || past === null || past === undefined) return null;
  const diff = Number(current) - Number(past);
  if (Number.isNaN(diff)) return null;
  const abs = Math.abs(diff).toFixed(2);
  if (diff > 0.005) return { text: `▲${abs}`, cls: 'ratio-up' };
  if (diff < -0.005) return { text: `▼${abs}`, cls: 'ratio-down' };
  return { text: '-', cls: 'ratio-same' };
}

async function toggleHistory(key) {
  const item = state.watchlist.find((w) => w.key === key);
  if (!item) return;
  if (state.historyOpen.has(key)) {
    state.historyOpen.delete(key);
    renderWatchlist();
    return;
  }
  state.historyOpen.add(key);
  renderWatchlist();

  const allCached = HISTORY_YEARS.every((y) => state.historyData.has(`${item.sourceUrl || item.university}:${y}`));
  if (!allCached) {
    try {
      await fetchHistory(item);
    } catch {}
    if (state.historyOpen.has(key)) {
      renderWatchlist();
    }
  }
}

function renderHistoryContent(container, item, results) {
  const guideBar = document.createElement('div');
  guideBar.className = 'history-guide-bar';
  const guideTitle = document.createElement('span');
  guideTitle.className = 'history-guide-title';
  guideTitle.textContent = `${item.university} ${item.admission}`;
  const guideBtn = document.createElement('a');
  guideBtn.className = 'btn-guide-link';
  guideBtn.href = getGuideUrl(item);
  guideBtn.target = '_blank';
  guideBtn.rel = 'noopener noreferrer';
  guideBtn.title = `${item.university} 모집요강 바로가기 (새 창)`;
  guideBtn.textContent = '📄 모집요강 바로가기 ↗';
  guideBtn.addEventListener('click', (e) => {
    e.stopPropagation();
  });
  guideBar.append(guideTitle, guideBtn);

  const sortedResults = [...results].sort((a, b) => a.year - b.year);
  const hasAny = sortedResults.some((r) => r.found);
  if (!hasAny) {
    const isUnsupported = sortedResults.some((r) => r.error && /NO_HISTORY|지원하지 않/.test(r.error));
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'history-empty-msg';
    emptyMsg.textContent = isUnsupported ? '과거 경쟁률 데이터가 제공되지 않는 대학입니다' : '과거 데이터를 찾지 못했습니다';
    container.replaceChildren(guideBar, emptyMsg);
    return;
  }

  const strip = document.createElement('div');
  strip.className = 'history-strip';

  // Past years
  sortedResults.forEach((r) => {
    const itemEl = document.createElement('div');
    itemEl.className = 'history-chip';

    const yearEl = document.createElement('div');
    yearEl.className = 'chip-year';
    yearEl.textContent = `${r.year}년`;

    const rateEl = document.createElement('div');
    rateEl.className = 'chip-rate';
    rateEl.textContent = r.found ? formatRatio(r.ratio) : '-';

    const countEl = document.createElement('div');
    countEl.className = 'chip-count';
    countEl.textContent = r.found ? `${formatCount(r.seats)}모집 · ${formatCount(r.applicants)}지원` : '자료 없음';

    itemEl.append(yearEl, rateEl, countEl);
    strip.append(itemEl);
  });

  // Current year (highlighted)
  const currentEl = document.createElement('div');
  currentEl.className = 'history-chip current';

  const currentYear = document.createElement('div');
  currentYear.className = 'chip-year';
  currentYear.textContent = '현재 실시간';

  const currentRate = document.createElement('div');
  currentRate.className = 'chip-rate current';
  currentRate.textContent = formatRatio(item.ratio);

  const lastFound = [...sortedResults].reverse().find((r) => r.found && r.ratio !== null);
  if (lastFound) {
    const delta = formatDelta(item.ratio, lastFound.ratio);
    if (delta && delta.text && delta.text !== '-') {
      const badge = document.createElement('span');
      badge.className = `delta-badge ${delta.cls === 'ratio-up' ? 'up' : 'down'}`;
      badge.textContent = delta.text;
      currentRate.append(badge);
    }
  }

  const currentCount = document.createElement('div');
  currentCount.className = 'chip-count';
  currentCount.textContent = `${formatCount(item.seats)}모집 · ${formatCount(item.applicants)}지원`;

  currentEl.append(currentYear, currentRate, currentCount);
  strip.append(currentEl);

  container.replaceChildren(guideBar, strip);
}

function renderWatchlist() {
  dom.watchBody.replaceChildren();
  dom.watchCount.textContent = String(state.watchlist.length);
  dom.navWatchCount.textContent = String(state.watchlist.length);
  dom.watchEmpty.hidden = state.watchlist.length > 0;
  dom.refreshButton.disabled = Boolean(state.refreshing) || state.watchlist.length === 0;
  dom.clearButton.disabled = Boolean(state.refreshing) || state.watchlist.length === 0;

  state.watchlist.forEach((item) => {
    const isOpen = state.historyOpen.has(item.key);
    const tr = document.createElement('tr');
    tr.className = 'watch-row' + (isOpen ? ' open' : '');
    tr.tabIndex = 0;
    tr.setAttribute('role', 'button');
    tr.setAttribute('aria-expanded', String(isOpen));
    tr.setAttribute('title', '클릭하여 과거 경쟁률 비교 펼치기/접기');

    tr.addEventListener('click', (e) => {
      if (e.target.closest('.remove') || e.target.closest('.btn-guide-tag')) return;
      toggleHistory(item.key);
    });
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        if (e.target.closest('.remove') || e.target.closest('.btn-guide-tag')) return;
        e.preventDefault();
        toggleHistory(item.key);
      }
    });

    // 1. University cell with arrow toggle icon and guide link
    const uniTd = document.createElement('td');
    uniTd.className = 'uni-cell';
    const toggleIcon = document.createElement('span');
    toggleIcon.className = 'toggle-icon' + (isOpen ? ' open' : '');
    toggleIcon.textContent = isOpen ? '▾' : '▸';
    toggleIcon.setAttribute('aria-hidden', 'true');
    const uniText = document.createElement('span');
    uniText.className = 'uni-name';
    uniText.textContent = item.university;

    const guideLink = document.createElement('a');
    guideLink.className = 'btn-guide-tag';
    guideLink.href = getGuideUrl(item);
    guideLink.target = '_blank';
    guideLink.rel = 'noopener noreferrer';
    guideLink.title = `${item.university} 모집요강 바로가기 (새 창)`;
    guideLink.setAttribute('aria-label', `${item.university} 모집요강 바로가기`);
    guideLink.textContent = '요강 ↗';
    guideLink.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    uniTd.append(toggleIcon, uniText, guideLink);

    // 2. Admission cell
    const admTd = document.createElement('td');
    admTd.className = 'adm-cell';
    admTd.textContent = item.admission;

    // 3. Department cell
    const deptTd = document.createElement('td');
    deptTd.className = 'dept-cell';
    deptTd.textContent = item.department;

    // 4. Seats
    const seats = document.createElement('td');
    seats.className = 'num';
    seats.textContent = formatCount(item.seats);

    // 5. Applicants
    const applicants = document.createElement('td');
    applicants.className = 'num';
    applicants.textContent = formatCount(item.applicants);

    // 6. Ratio
    const ratio = document.createElement('td');
    ratio.className = 'num ratio-cell';
    ratio.textContent = formatRatio(item.ratio);

    // 7. Provider updated
    const providerUpdated = document.createElement('td');
    providerUpdated.className = 'provider-updated-at';
    providerUpdated.textContent = formatProviderUpdatedAt(item.providerUpdatedAt);
    if (item.refreshError) {
      providerUpdated.classList.add('refresh-error');
      providerUpdated.textContent = `${providerUpdated.textContent || '-'} · 갱신 실패: ${item.refreshError}`;
    }

    // 8. Remove button
    const remove = document.createElement('td');
    remove.className = 'remove';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '삭제';
    button.title = '관심 목록에서 삭제';
    button.disabled = Boolean(state.refreshing);
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      removeWatch(item.key);
    });
    remove.append(button);

    tr.append(uniTd, admTd, deptTd, seats, applicants, ratio, providerUpdated, remove);
    dom.watchBody.append(tr);

    if (isOpen) {
      const expandTr = document.createElement('tr');
      expandTr.className = 'history-expand open';
      expandTr.dataset.historyKey = item.key;
      const expandTd = document.createElement('td');
      expandTd.colSpan = 8;
      const inner = document.createElement('div');
      inner.className = 'history-inner';
      const allCached = HISTORY_YEARS.every((y) => state.historyData.has(`${item.sourceUrl || item.university}:${y}`));
      if (allCached) {
        const results = HISTORY_YEARS.map((year) => ({ year, ...state.historyData.get(`${item.sourceUrl || item.university}:${year}`) }));
        renderHistoryContent(inner, item, results);
      } else {
        inner.innerHTML = '<div class="history-loading"><span class="loading-spinner"></span> 과거 경쟁률을 불러오는 중...</div>';
      }
      expandTd.append(inner);
      expandTr.append(expandTd);
      dom.watchBody.append(expandTr);
    }
  });
}

function findWatchRow(data, item) {
  const type = data.admissionTypes.find((candidate) => (
    (item.admissionId && candidate.id === item.admissionId) || candidate.name === item.admission
  ));
  if (!type) return null;
  const row = type.rows.find((candidate) => (
    (item.departmentId && candidate.id === item.departmentId) || candidate.name === item.department
  ));
  return row ? { type, row } : null;
}

async function fetchWatchData(item) {
  if (!item.sourceUrl) throw new Error('경쟁률 원문 URL이 없습니다.');
  const params = new URLSearchParams({
    url: item.sourceUrl,
    name: item.university || '',
    provider: item.provider || '',
    refresh: '1'
  });
  return normalize(await fetchJson(`/api/competition?${params.toString()}`));
}

async function refreshWatchlist() {
  if (!state.watchlist.length || state.refreshing) return;
  state.refreshing = true;
  dom.refreshButton.textContent = '새로고침 중...';
  dom.refreshStatus.textContent = '관심 목록을 새로고침하는 중...';
  dom.refreshStatus.classList.remove('error');
  renderWatchlist();

  const sourceResults = new Map();
  const sourceItems = new Map();
  state.watchlist.forEach((item) => {
    if (item.sourceUrl && !sourceItems.has(item.sourceUrl)) sourceItems.set(item.sourceUrl, item);
  });

  try {
    await Promise.all([...sourceItems.entries()].map(async ([sourceUrl, item]) => {
      try {
        sourceResults.set(sourceUrl, { data: await fetchWatchData(item) });
      } catch (error) {
        sourceResults.set(sourceUrl, { error: error.message || '경쟁률을 불러오지 못했습니다.' });
      }
    }));

    let success = 0;
    let failed = 0;
    state.watchlist = state.watchlist.map((item) => {
      const result = item.sourceUrl
        ? sourceResults.get(item.sourceUrl)
        : { error: '경쟁률 원문 URL이 없습니다.' };
      if (!result?.data) {
        failed += 1;
        return { ...item, refreshError: result?.error || '경쟁률을 불러오지 못했습니다.' };
      }
      const warning = staleWarning(result.data);
      if (warning) {
        failed += 1;
        return { ...item, refreshError: warning };
      }
      const match = findWatchRow(result.data, item);
      if (!match) {
        failed += 1;
        return { ...item, refreshError: '최신 경쟁률에서 해당 모집단위를 찾지 못했습니다.' };
      }
      const sourceUrl = result.data.source?.url || item.sourceUrl;
      const source = result.data.source || {};
      success += 1;
      return {
        ...item,
        key: `${sourceUrl}::${match.type.id}::${match.row.id}`,
        university: result.data.university || item.university,
        admissionId: match.type.id,
        admission: match.type.name,
        departmentId: match.row.id,
        department: match.row.name,
        seats: match.row.seats,
        applicants: match.row.applicants,
        ratio: match.row.ratio,
        sourceUrl,
        provider: source.provider || item.provider || '',
        providerUpdatedAt: result.data.updatedAt || item.providerUpdatedAt || '',
        providerUpdateInterval: source.updateInterval || item.providerUpdateInterval || '',
        providerNote: result.data.note || item.providerNote || '',
        guideUrl: result.data.guideUrl || result.data.source?.guideUrl || item.guideUrl || '',
        refreshedAt: result.data.fetchedAt || new Date().toISOString(),
        refreshError: ''
      };
    });
    saveWatchlist();
    dom.refreshStatus.textContent = failed
      ? `전체 새로고침 완료 · ${success}개 성공, ${failed}개 실패`
      : `전체 새로고침 완료 · ${success}개 항목`;
    dom.refreshStatus.classList.toggle('error', failed > 0);
  } catch (error) {
    dom.refreshStatus.textContent = `전체 새로고침 실패: ${error.message || '알 수 없는 오류'}`;
    dom.refreshStatus.classList.add('error');
  } finally {
    state.refreshing = false;
    dom.refreshButton.textContent = '전체 새로고침';
    renderWatchlist();
    updateAddButton();
  }
}


function setActiveScreen(screen) {
  const target = screen === 'watch' ? 'watch' : 'search';
  const isSearch = target === 'search';
  dom.searchScreen.hidden = !isSearch;
  dom.watchScreen.hidden = isSearch;
  dom.navItems.forEach((button) => {
    const active = button.dataset.navTarget === target;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}


function bindEvents() {
  dom.universityForm.addEventListener('submit', (event) => {
    event.preventDefault();
    searchUniversities();
  });
  dom.departmentQuery.addEventListener('input', renderDepartmentResults);
  dom.addButton.addEventListener('click', addCurrent);
  dom.refreshButton.addEventListener('click', refreshWatchlist);
  dom.clearButton.addEventListener('click', () => {
    if (!state.watchlist.length || state.refreshing) return;
    state.watchlist = [];
    saveWatchlist();
    dom.refreshStatus.textContent = '';
    dom.refreshStatus.classList.remove('error');
    renderWatchlist();
    updateAddButton();
  });
  dom.navItems.forEach((button) => {
    button.addEventListener('click', () => setActiveScreen(button.dataset.navTarget));
  });
}

function cacheDom() {
  [
    'universityForm', 'universityQuery', 'universitySearchButton', 'universityResults', 'status',
    'currentUniversity', 'departmentQuery', 'departmentResults', 'selectionInfo', 'addButton',
    'watchCount', 'navWatchCount', 'refreshButton', 'refreshStatus', 'clearButton', 'watchBody',
    'watchEmpty', 'searchScreen', 'watchScreen'
  ].forEach((id) => { dom[id] = $(id); });
  dom.navItems = Array.from(document.querySelectorAll('[data-nav-target]'));
}

async function init() {
  cacheDom();
  state.refreshing = false;
  setActiveScreen('search');
  bindEvents();
  loadWatchlist();
  renderWatchlist();
}

document.addEventListener('DOMContentLoaded', init);
