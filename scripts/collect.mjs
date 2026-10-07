// 서울 생활인구(250m) 수집기
// - 행정동별: 최근 LOOKBACK_DAYS일 중 비어 있는 날짜를 시간대별로 조회
// - 격자별: API가 제공하는 하루치(약 4일 전)를 전부 넘겨 받아 관심 격자만 보관
// 실행: SEOUL_API_KEY=... node scripts/collect.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'docs', 'data');
const KEY = process.env.SEOUL_API_KEY;
const BASE = process.env.SEOUL_API_BASE || 'http://openapi.seoul.go.kr:8088';
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const PAGE = 1000;
const CONCURRENCY = 4;

const AGES = ['00', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55', '60', '65', '70'];
const NUM_COLS = ['SPOP', ...AGES.map((a) => 'M' + a), ...AGES.map((a) => 'F' + a)];
const HEADER = ['ymd', 'tt', 'id', ...NUM_COLS.map((c) => c.toLowerCase())];

const SVC_DONG = 'Spop250mLocalResdDong';
const SVC_CELL = 'Se250MSpopLocalResd';

if (!KEY) {
  console.error('SEOUL_API_KEY 환경변수가 없습니다.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 인증키가 URL에 들어가므로 URL은 절대 로그에 남기지 않는다.
async function call(service, start, end, ...params) {
  const url = [BASE, KEY, 'json', service, start, end, ...params].join('/');
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        // 오류일 때는 json을 요청해도 XML로 내려오는 경우가 있다.
        const code = /<CODE>([^<]+)<\/CODE>/.exec(text)?.[1];
        throw new Error(`응답 해석 실패 (${code || 'HTTP ' + res.status})`);
      }
      const payload = body[service];
      const result = payload?.RESULT || body.RESULT;
      const code = result?.CODE;
      if (code === 'INFO-200') return { total: 0, rows: [] };
      if (code !== 'INFO-000') throw new Error(`${code}: ${result?.MESSAGE || ''}`.trim());
      return { total: payload.list_total_count, rows: payload.row || [] };
    } catch (e) {
      lastErr = e;
      // 인증키 오류·요청 형식 오류는 재시도해도 같으므로 바로 중단
      if (/INFO-100|ERROR-3\d\d/.test(e.message)) break;
      await sleep(1500 * attempt);
    }
  }
  throw new Error(`${service} ${start}-${end} ${params.join('/')}: ${lastErr.message}`);
}

async function pool(items, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await worker(items[i]);
      }
    }),
  );
  return out;
}

const clean = (v) => (v == null || v === '*' ? '' : String(v).trim());
const toRecord = (row, id) => [clean(row.YMD), clean(row.TT).padStart(2, '0'), id, ...NUM_COLS.map((c) => clean(row[c]))];

async function loadCsv(file) {
  const map = new Map();
  if (!existsSync(file)) return map;
  const lines = (await readFile(file, 'utf8')).split('\n').slice(1);
  for (const line of lines) {
    if (!line) continue;
    const f = line.split(',');
    map.set(f.slice(0, 3).join('|'), f);
  }
  return map;
}

async function saveCsv(file, map) {
  const rows = [...map.values()].sort((a, b) => (a[0] + a[1] + a[2] < b[0] + b[1] + b[2] ? -1 : 1));
  await writeFile(file, [HEADER.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n');
}

// 한국 시간 기준 n일 전 날짜(YYYYMMDD)
function kstDate(daysAgo) {
  const t = new Date(Date.now() + 9 * 3600_000 - daysAgo * 86400_000);
  return t.toISOString().slice(0, 10).replaceAll('-', '');
}

function datesWith(map, ids) {
  // 날짜별로 (id, 시간) 조합이 모두 채워졌는지 센다
  const count = new Map();
  for (const f of map.values()) count.set(f[0], (count.get(f[0]) || 0) + 1);
  return new Set([...count].filter(([, n]) => n >= ids.length * 24).map(([d]) => d));
}

async function collectDong(dongIds) {
  const file = path.join(DATA, 'dong.csv');
  const map = await loadCsv(file);
  const done = datesWith(map, dongIds);
  const want = new Set(dongIds);
  let added = 0;
  for (let ago = LOOKBACK_DAYS; ago >= 1; ago--) {
    const ymd = kstDate(ago);
    if (done.has(ymd)) continue;
    const hours = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
    const first = await call(SVC_DONG, 1, PAGE, ymd, hours[0]);
    if (first.total === 0) {
      console.log(`[행정동] ${ymd}: 아직 제공되지 않음`);
      continue;
    }
    const rest = await pool(hours.slice(1), (tt) => call(SVC_DONG, 1, PAGE, ymd, tt));
    let n = 0;
    for (const { rows } of [first, ...rest]) {
      for (const row of rows) {
        const id = clean(row.H_DNG_CD);
        if (!want.has(id)) continue;
        const rec = toRecord(row, id);
        map.set(rec.slice(0, 3).join('|'), rec);
        n++;
      }
    }
    console.log(`[행정동] ${ymd}: ${n}행 저장`);
    added += n;
  }
  await saveCsv(file, map);
  return { added, dates: [...new Set([...map.values()].map((f) => f[0]))].sort() };
}

async function collectCell(cellIds) {
  const file = path.join(DATA, 'cell.csv');
  const map = await loadCsv(file);
  const done = datesWith(map, cellIds);
  const want = new Set(cellIds);
  let added = 0;

  // 격자 API는 날짜를 고를 수 없고 하루치만 내려준다. 첫 쪽으로 날짜와 전체 건수를 확인한다.
  const first = await call(SVC_CELL, 1, PAGE);
  const ymd = clean(first.rows[0]?.YMD);
  if (!first.total || !ymd) {
    console.log('[격자] 제공 중인 데이터 없음');
  } else if (done.has(ymd)) {
    console.log(`[격자] ${ymd}: 이미 수집됨 (전체 ${first.total}행 건너뜀)`);
  } else {
    const starts = [];
    for (let s = PAGE + 1; s <= first.total; s += PAGE) starts.push(s);
    const rest = await pool(starts, (s) => call(SVC_CELL, s, Math.min(s + PAGE - 1, first.total)));
    for (const { rows } of [first, ...rest]) {
      for (const row of rows) {
        const id = clean(row.CELL_ID);
        if (!want.has(id)) continue;
        const rec = toRecord(row, id);
        // 한 격자가 여러 행정동에 걸치면 행이 나뉘어 오므로 합산한다
        const key = rec.slice(0, 3).join('|');
        const prev = map.get(key);
        if (prev && prev.fresh) {
          for (let i = 3; i < rec.length; i++) {
            if (rec[i] === '' && prev[i] === '') continue;
            prev[i] = String(Math.round((Number(prev[i] || 0) + Number(rec[i] || 0)) * 100) / 100);
          }
        } else {
          rec.fresh = true;
          map.set(key, rec);
        }
        added++;
      }
    }
    console.log(`[격자] ${ymd}: 전체 ${first.total}행 중 ${added}행 저장`);
  }
  await saveCsv(file, map);
  return { added, dates: [...new Set([...map.values()].map((f) => f[0]))].sort() };
}

const areas = JSON.parse(await readFile(path.join(DATA, 'areas.json'), 'utf8'));
const errors = [];
const meta = { updatedAt: new Date().toISOString() };

for (const [name, fn, ids] of [
  ['dong', collectDong, areas.dongs.map((d) => d.id)],
  ['cell', collectCell, areas.cells.map((c) => c.id)],
]) {
  try {
    const r = await fn(ids);
    meta[name] = { first: r.dates[0] || null, last: r.dates.at(-1) || null, days: r.dates.length };
  } catch (e) {
    console.error(`[${name}] 실패: ${e.message}`);
    errors.push(name);
  }
}

if (!errors.length) await writeFile(path.join(DATA, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
process.exit(errors.length ? 1 : 0);
