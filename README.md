# 종로3가 생활인구 기록

서울 열린데이터광장의 「서울 생활인구(250m)」 데이터를 매일 받아 쌓고, 시간대별 인구·성비·연령 분포를 보여주는 사이트입니다.

- 수집: GitHub Actions가 하루 두 번(한국 시간 06:17, 18:17) `scripts/collect.mjs`를 실행합니다.
- 저장: `docs/data/dong.csv`(행정동), `docs/data/cell.csv`(250m 격자)에 누적됩니다.
- 사이트: `docs/` 폴더를 GitHub Pages로 배포합니다.

## 처음 한 번만 하는 설정

1. **API 키 등록**: 저장소 Settings → Secrets and variables → Actions → New repository secret
   - Name: `SEOUL_API_KEY`
   - Secret: 서울 열린데이터광장에서 발급받은 인증키
2. **Pages 켜기**: Settings → Pages → Source를 "Deploy from a branch"로, Branch를 `main` / `/docs`로 지정하고 Save
3. **첫 실행 확인**: Actions 탭 → "생활인구 수집" → Run workflow. 초록색 체크가 뜨면 정상입니다.

사이트 주소는 `https://<계정명>.github.io/<저장소명>/`입니다.

## 수집 대상 바꾸기

`docs/data/areas.json`을 고치면 됩니다.

- `dongs`: 행정동 코드(8자리)
- `cells`: 250m 격자 ID(예: `다사55005250`). [격자 선택기](https://data.seoul.go.kr/opendata/seoulStay/grid_viewer.html)에서 확인할 수 있습니다.
- `groups`: 여러 격자를 합쳐 하나의 지역으로 보여줄 때 씁니다.

## 알아둘 점

- 격자 API는 약 4일 전 하루치만 제공합니다. 수집이 며칠 멈추면 그 기간의 격자 데이터는 비게 되고, 열린데이터광장의 월별 파일로만 메울 수 있습니다.
- 행정동 API는 최근 2개월을 제공하므로, 수집이 멈췄다 재개돼도 최근 14일은 자동으로 채워집니다(`LOOKBACK_DAYS`로 조정).
- 내국인만 집계된 추계 인구입니다.

## 내 PC에서 직접 실행

```bash
SEOUL_API_KEY=발급받은키 node scripts/collect.mjs   # Node.js 20 이상
npx serve docs                                      # 사이트 미리보기
```

출처: 서울 열린데이터광장(서울특별시), 공공누리 제1유형
