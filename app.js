'use strict';

const WATCH_KEY = 'ratio-watchlist-v1';
const numberFormat = new Intl.NumberFormat('ko-KR');

const state = {
  catalog: [],
  searchResults: [],
  data: null,
  university: null,
  admissionId: '',
  departmentId: '',
  watchlist: [],
  loading: false
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

function addCurrent() {
  const row = currentRow();
  const type = currentType();
  if (!row || !type || !state.data) return;
  const key = watchKey(row, type);
  if (state.watchlist.some((item) => item.key === key)) return;
  const source = state.data.source || {};
  const warning = staleWarning(state.data);
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

function renderWatchlist() {
  dom.watchBody.replaceChildren();
  dom.watchCount.textContent = String(state.watchlist.length);
  dom.navWatchCount.textContent = String(state.watchlist.length);
  dom.watchEmpty.hidden = state.watchlist.length > 0;
  dom.refreshButton.disabled = Boolean(state.refreshing) || state.watchlist.length === 0;
  dom.clearButton.disabled = Boolean(state.refreshing) || state.watchlist.length === 0;
  state.watchlist.forEach((item) => {
    const tr = document.createElement('tr');
    const cells = [item.university, item.admission, item.department].map((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      return td;
    });
    const seats = document.createElement('td');
    seats.className = 'num';
    seats.textContent = formatCount(item.seats);
    const applicants = document.createElement('td');
    applicants.className = 'num';
    applicants.textContent = formatCount(item.applicants);
    const ratio = document.createElement('td');
    ratio.className = 'num';
    ratio.textContent = formatRatio(item.ratio);
    const providerUpdated = document.createElement('td');
    providerUpdated.className = 'provider-updated-at';
    providerUpdated.textContent = formatProviderUpdatedAt(item.providerUpdatedAt);
    if (item.refreshError) {
      providerUpdated.classList.add('refresh-error');
      providerUpdated.textContent = `${providerUpdated.textContent || '-'} · 갱신 실패: ${item.refreshError}`;
    }
    const remove = document.createElement('td');
    remove.className = 'remove';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '삭제';
    button.disabled = Boolean(state.refreshing);
    button.addEventListener('click', () => removeWatch(item.key));
    remove.append(button);
    tr.append(...cells, seats, applicants, ratio, providerUpdated, remove);
    dom.watchBody.append(tr);
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
