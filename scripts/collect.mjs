// 서울 생활인구(250m) 수집기
// - 행정동: 최근 LOOKBACK_DAYS일 중 비어 있는 날짜를 시간대별로 조회
// - 핫플: 격자 API가 제공하는 하루치(약 4일 전)를 전부 넘겨 받아, 핫플별 격자 묶음의 합만 보관
// 수집 대상은 docs/data/areas.json 에서 정한다.
// 실행: SEOUL_API_KEY=... node scripts/collect.mjs
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
// 파일 크기를 줄이려고 행정동 값은 정수로 반올림해 저장한다 (가려진 값 *은 빈칸)
const toRecord = (row, id) => [clean(row.YMD), clean(row.TT).padStart(2, '0'), id, ...NUM_COLS.map((c) => (clean(row[c]) === '' ? '' : String(Math.round(Number(row[c])))))];

// 데이터는 종류별 폴더에 월 단위 파일(YYYY-MM.csv)로 나눠 쌓는다.
async function loadDir(kind) {
  const dir = path.join(DATA, kind);
  const map = new Map();
  if (!existsSync(dir)) return map;
  for (const name of (await readdir(dir)).filter((n) => /^\d{4}-\d{2}\.csv$/.test(n))) {
    for (const line of (await readFile(path.join(dir, name), 'utf8')).split('\n').slice(1)) {
      if (!line) continue;
      const f = line.split(',');
      map.set(f.slice(0, 3).join('|'), f);
    }
  }
  return map;
}

async function saveDir(kind, map) {
  const dir = path.join(DATA, kind);
  await mkdir(dir, { recursive: true });
  const byMonth = new Map();
  for (const f of map.values()) {
    const m = f[0].slice(0, 4) + '-' + f[0].slice(4, 6);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(f);
  }
  for (const [m, rows] of byMonth) {
    rows.sort((x, y) => (x[0] + x[1] + x[2] < y[0] + y[1] + y[2] ? -1 : 1));
    await writeFile(path.join(dir, m + '.csv'), [HEADER.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n');
  }
  const dates = [...new Set([...map.values()].map((f) => f[0]))].sort();
  return { months: [...byMonth.keys()].sort(), first: dates[0] || null, last: dates.at(-1) || null, days: dates.length };
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
  const map = await loadDir('dong');
  const done = datesWith(map, dongIds);
  const want = new Set(dongIds);
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
  }
  return saveDir('dong', map);
}

// 핫플은 격자 여러 개의 합으로 저장한다. 격자 원본 행은 보관하지 않는다.
async function collectPlace(places, prevDone) {
  const map = await loadDir('place');
  const cellToPlaces = new Map();
  for (const p of places) for (const c of p.cells) cellToPlaces.set(c, [...(cellToPlaces.get(c) || []), p.id]);
  // 수집 대상이 바뀌면 같은 날짜라도 다시 받도록 설정 지문을 함께 기록한다
  const sig = createHash('sha1').update(JSON.stringify(places.map((p) => [p.id, p.cells]))).digest('hex').slice(0, 12);
  const done = { ...prevDone };

  // 격자 API는 날짜를 고를 수 없고 하루치만 내려준다. 첫 쪽으로 날짜와 전체 건수를 확인한다.
  const first = await call(SVC_CELL, 1, PAGE);
  const ymd = clean(first.rows[0]?.YMD);
  if (!first.total || !ymd) {
    console.log('[핫플] 제공 중인 격자 데이터 없음');
  } else if (done[ymd] === sig) {
    console.log(`[핫플] ${ymd}: 이미 수집됨 (전체 ${first.total}행 건너뜀)`);
  } else {
    const starts = [];
    for (let s = PAGE + 1; s <= first.total; s += PAGE) starts.push(s);
    const rest = await pool(starts, (s) => call(SVC_CELL, s, Math.min(s + PAGE - 1, first.total)));
    const acc = new Map();
    let used = 0;
    for (const { rows } of [first, ...rest]) {
      for (const row of rows) {
        const ids = cellToPlaces.get(clean(row.CELL_ID));
        if (!ids) continue;
        used++;
        const rowYmd = clean(row.YMD), tt = clean(row.TT).padStart(2, '0');
        for (const id of ids) {
          const key = [rowYmd, tt, id].join('|');
          if (!acc.has(key)) acc.set(key, { head: [rowYmd, tt, id], sums: NUM_COLS.map(() => 0) });
          const a = acc.get(key);
          // 3명 이하로 가려진 값(*)은 0으로 더한다
          NUM_COLS.forEach((c, i) => (a.sums[i] += Number(clean(row[c])) || 0));
        }
      }
    }
    for (const [key, a] of acc) map.set(key, [...a.head, ...a.sums.map((v) => String(Math.round(v * 10) / 10))]);
    done[ymd] = sig;
    console.log(`[핫플] ${ymd}: 전체 ${first.total}행 중 격자 ${used}행을 ${acc.size}행으로 합산`);
  }
  const info = await saveDir('place', map);
  // 완료 기록은 최근 40일만 남긴다
  info.done = Object.fromEntries(Object.entries(done).sort().slice(-40));
  return info;
}

const areas = JSON.parse(await readFile(path.join(DATA, 'areas.json'), 'utf8'));
const indexFile = path.join(DATA, 'index.json');
const prev = existsSync(indexFile) ? JSON.parse(await readFile(indexFile, 'utf8')) : {};
const index = { ...prev, updatedAt: new Date().toISOString() };
const errors = [];

for (const [name, fn] of [
  ['dong', () => collectDong(areas.dongs.map((d) => d.id))],
  ['place', () => collectPlace(areas.places, prev.place?.done || {})],
]) {
  try {
    index[name] = await fn();
  } catch (e) {
    console.error(`[${name}] 실패: ${e.message}`);
    errors.push(name);
  }
}

// 한쪽이 실패해도 성공한 쪽의 결과는 남긴다
await writeFile(indexFile, JSON.stringify(index, null, 2) + '\n');
process.exit(errors.length ? 1 : 0);
