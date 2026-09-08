# Render 진학어플라이 접속 오류 수정

## 확인된 현상

2026-09-08에 `https://competition-rate.onrender.com`을 직접 조회했습니다.

| 조회 | 현재 Render 응답 |
| --- | --- |
| 가톨릭 대학명 검색 | 정상, HTTP 200 |
| 극동대학교 (유웨이) | 정상, 10개 전형 / 58개 행 |
| 강원대학교 (유웨이) | 정상, 50개 전형 / 1,173개 행 |
| 서울시립대학교 (유웨이) | 정상, 7개 전형 / 160개 행 |
| 가톨릭대학교 (진학어플라이) | HTTP 502, 원문 응답 오류 (403) |

동일한 진학어플라이 원문은 작업 PC에서 HTTP 200으로 열렸으며, 수정 코드에서 273개 행을 파싱했습니다. Render 출발 요청에 대한 IP/보안 정책 차단 가능성이 높습니다. 진학어플라이의 차단 로그를 확인한 것은 아니므로 국가 제한인지 데이터센터 IP 제한인지는 확정할 수 없습니다.

**현재 운영 배포는 변경하지 않았습니다. 먼저 수정본을 직접 연결로 재배포하고 확인하세요. 그래도 IP 차단이 계속되면 실제 접속이 허용되는 국내 프록시 연결이 필요합니다. 코드만 업로드하면 한국 IP가 생기는 것은 아닙니다.**

기존 코드가 유웨이 쿠키를 진학어플라이에도 전송하던 부분을 분리했습니다. Render의 실제 쿠키 환경변수는 읽지 않았으므로 이것이 운영 403의 원인인지는 알 수 없습니다. 불필요한 프록시 도입 전에 수정본의 직접 연결부터 확인하는 이유입니다.

## 국내 서버나 프록시가 없을 때

수정본을 직접 연결로 배포한 뒤에도 403이 계속되고 Render를 유지하려면 한국 출구 IP를 제공하는 HTTP/HTTPS CONNECT 프록시 하나를 준비합니다. 별도의 웹사이트를 만들 필요는 없습니다. 프록시 제공처에 다음 조건을 확인하세요.

- 한국 출구 IP, HTTPS 대상에 대한 CONNECT(443) 지원
- 서버용 주소, 포트, 사용자명/비밀번호 또는 Render 출발 IP 허용 방식 제공
- `https://addon.jinhakapply.com/RatioV1/RatioH/Ratio10030381.html`이 해당 출구 IP에서 HTTP 200으로 열리는지 시험 가능

한국 IP여도 원문에서 차단될 수 있으므로 해당 URL의 접속 성공을 먼저 확인해야 합니다. 프록시 구매·가입은 수행하지 않았습니다.

프록시를 사용하지 않으려면 앱 전체를 원문 접근이 가능한 국내 서버에서 실행하는 방법이 있습니다. 당장 PC에서만 사용할 경우에는 아래 로컬 실행 절차로 실행할 수 있습니다. PC 실행은 Render의 문제를 해결하거나 24시간 공개 서비스를 제공하는 방식은 아닙니다.

Render에는 현재 한국 리전이 없습니다. 싱가포르로 옮겨도 한국 IP가 되지 않습니다. [Render 리전 문서](https://render.com/docs/regions)

## 기존 GitHub 저장소와 Render에 반영

1. ZIP을 풀고 기존 저장소 루트에 덮어씁니다. `server.mjs`, `scraper-fetch.mjs`, `app.js`, `package.json`, `package-lock.json`, `.node-version`은 반드시 함께 반영하세요. `scripts`와 `test` 폴더도 포함합니다. ZIP 안에 `node_modules`와 비밀값은 없습니다.
2. GitHub에 커밋합니다. 현재 연결 계정은 이 저장소에 쓰기 권한이 없어 자동 커밋/배포는 수행하지 못했습니다.
3. Render에서 기존 `competition-rate` 서비스의 설정을 확인합니다.

| 설정 | 값 |
| --- | --- |
| Build Command | `npm ci --omit=dev` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |
| `NODE_VERSION` 환경변수 | `24` |

4. 프록시가 없는 지금은 `SCRAPER_PROXY_URL`을 설정하지 않고 최신 코드를 배포한 다음 아래의 진학어플라이 실제 조회 URL을 확인하세요. 403이 계속될 때 프록시를 준비해 서비스의 **Environment → Add Environment Variable**에서 아래 값을 저장합니다. 예시의 `USERNAME`, `PASSWORD`, `HOST`, `PORT`는 제공받은 실제 값으로 바꿉니다.

```dotenv
SCRAPER_PROXY_URL=http://USERNAME:PASSWORD@HOST:PORT
SCRAPER_PROXY_HOSTS=addon.jinhakapply.com
```

제공처가 HTTPS 프록시 주소를 제공하면 `https://`를 사용하세요. 프록시 주소의 프로토콜은 경쟁률 원문의 `https://`와 별개입니다. 비밀번호에 `@`, `:`, `/`, `#` 등이 있으면 URL 인코딩한 값을 사용합니다(예: `@` → `%40`). 실제 인증값은 GitHub 파일이나 채팅에 적지 말고 Render 환경변수에만 저장하세요.

5. **Save, rebuild, and deploy**로 반영합니다. 기존 배포 자동 연동 상태에 따라 먼저 최신 커밋의 빌드가 필요할 수 있습니다. [환경변수 저장/배포 공식 안내](https://render.com/docs/configure-environment-variables)

이 설정은 진학어플라이의 세션 초기 요청과 상세 요청 모두에 프록시를 적용합니다. 유웨이 검색과 상세는 기존 직접 연결을 사용합니다. `SCRAPER_PROXY_URL`이 비어 있으면 직접 연결하며, 실제 국내 연결이 구성됐다고 표시하지 않습니다. 설정된 프록시가 실패해도 직접 연결로 몰래 재시도하지 않습니다.

`UWAY_COOKIE`는 유웨이에만, `JINHAK_COOKIE`는 진학어플라이에만 전송합니다. 쿠키를 추가하는 것만으로 출발지 IP가 바뀌지는 않습니다. `.env.example`은 설명용이며 자동 로드하지 않습니다.

## 배포 후 확인

1. [상태 확인](https://competition-rate.onrender.com/api/health): 직접 연결이면 `proxyConfigured: false`입니다. 프록시를 설정한 경우에는 `proxyConfigured: true`이고 `proxyHosts`에 `addon.jinhakapply.com`이 있어야 합니다. 이는 설정 여부만 뜻하며 원문 접속 성공을 보증하지 않습니다.
2. [진학어플라이 실제 조회](https://competition-rate.onrender.com/api/competition?university=catholic&refresh=1): HTTP 200, `live: true`, `admissionTypes` 내 실제 행이 있어야 합니다. `stale: true`는 해결 완료가 아닙니다.
3. [유웨이 실제 조회](https://competition-rate.onrender.com/api/competition?university=far-east&refresh=1)와 화면에서 대학 검색·학과 선택·관심 목록 새로고침을 확인합니다.

실행 로그에서 `Scraper proxy configured: true; hosts: addon.jinhakapply.com`을 검색할 수 있습니다. 프록시 주소나 비밀번호는 출력하지 않습니다.

| 오류 코드 | 확인할 내용 |
| --- | --- |
| `PROXY_CONFIG` | 프록시 URL/대상 도메인의 형식 |
| `PROXY_AUTH_FAILED` | 사용자명·비밀번호, 인증 방식 |
| `PROXY_CONNECTION_FAILED` | 주소·포트·방화벽·Render 출발 IP 허용 |
| `UPSTREAM_FORBIDDEN` | 그 출구 IP에서 원문을 열 수 있는지; 프록시를 켜도 403이면 연결 제공처/원문 운영자 확인 |
| `UPSTREAM_RATE_LIMITED` | 원문 요청 한도, 잠시 대기 후 재조회 |
| `UPSTREAM_BLOCK_PAGE` | HTTP 200이어도 원문이 차단 안내를 반환한 경우 |

프록시 설정 문제가 생기면 `SCRAPER_PROXY_URL`을 삭제하고 다시 배포하면 직접 연결로 돌아옵니다. 다만 기존 진학어플라이 403 문제도 다시 발생할 수 있습니다.

## 로컬 실행과 진단

Node.js 24를 사용하고 압축을 푼 폴더에서 실행합니다. Windows PowerShell에서는 `npm` 대신 `npm.cmd`로 입력해도 됩니다.

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd start
```

브라우저에서 `http://localhost:3000`을 엽니다. 중지/재시작은 실행 터미널에서 `Ctrl+C` 후 `npm.cmd start`입니다.

```powershell
npm.cmd run diagnose
```

이 진단은 실행한 환경의 접속 경로로 실제 대학 검색과 유웨이·진학어플라이 상세를 읽고 성공 여부·행 수·원문 갱신 시각을 출력합니다. PC에서의 성공은 Render에서의 성공과 별개입니다.

로컬에서 `.env`를 사용할 때는 `.env.example`을 복사해 값을 채운 뒤 `node --env-file=.env server.mjs` 또는 `node --env-file=.env scripts/check-sources.mjs`로 실행합니다. `.env`는 업로드하지 않습니다.

## 함께 수정한 오류

- HTTP 403/429, 프록시 인증 실패와 HTTP 200 차단 안내를 구분합니다.
- 원문 수집 실패 때 과거 캐시를 최신 갱신 성공으로 표시하지 않습니다.
- 프록시 비밀값과 서버 파일이 정적 파일 URL로 노출되지 않도록 공개 파일만 제공합니다.
- 원문 URL과 리다이렉트의 호스트·프로토콜·포트·사용자정보를 검증합니다.

Node 버전 설정 우선순위는 `NODE_VERSION` → `.node-version` → `.nvmrc` → `package.json`입니다. 기존 환경변수에 이전 버전이 있으면 함께 변경하세요. [공식 Node 버전 설정](https://render.com/docs/node-version)
