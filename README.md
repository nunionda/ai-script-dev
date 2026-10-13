# FRAME — 시나리오 개발 작업실

Final Draft처럼 표준 서식으로 시나리오를 쓰고, 장면 보드·작업본·AI 개발 파트너로 원고를 함께 발전시키는 웹 플랫폼입니다.
화면 구성은 `design/writers-room.html` 시안을 따릅니다.

## 실행

```bash
npm install
npm run dev          # API(8787) + 웹(5173) → http://localhost:5173
```

AI 개발 파트너를 쓰려면 Claude API 키를 넣고 실행합니다.

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run dev
```

배포용: `npm run build && npm start` (API와 빌드된 웹을 `PORT`(기본 8787) 하나로 제공)

| 환경 변수 | 설명 |
|---|---|
| `ANTHROPIC_API_KEY` | AI 개발 파트너 활성화 |
| `FRAME_MODEL` | 사용할 Claude 모델 (기본 `claude-opus-5-5`) |
| `FRAME_DB` | SQLite 파일 경로 (기본 `data/frame.db`) |
| `PORT` | API 서버 포트 |

처음 실행하면 예시 작품 "마지막 상영"이 만들어집니다. `data/frame.db`를 지우면 다시 처음 상태가 됩니다.

## 기능

**집필 (Final Draft 방식 에디터)**
- 요소: 씬 헤딩 · 지문 · 인물 · 괄호 · 대사 · 전환 · 샷 · 일반
- `Enter`로 다음 요소 자동 전환(헤딩→지문, 인물→대사, 대사→지문), `Tab`/`Shift+Tab`로 요소 순환, `Ctrl+1~8` 직접 지정
- SmartType 자동 완성: 인물 이름, `내부./외부./INT./EXT.`, 장소, 시간대, 전환
- 페이지 나눔 실시간 표시(페이지당 55줄 기준, 한글은 2칸), 장면 번호 자동 매김
- 한국식(`S#1. 내부. 영사실 - 밤`) / 할리우드식(`1 INT. BOOTH - NIGHT`) 서식
- 찾기·바꾸기(`Ctrl+F`), 집중 모드(`Ctrl+Shift+F`), 실행 취소, 자동 저장 + 충돌 감지
- Fountain 텍스트 붙여넣기 시 요소 자동 인식

**스토리 구성** — 막별 인덱스 카드, 끌어서 순서·막 변경(원고에 반영), 장면 요약·의도, AI 요약, 열린 질문

**AI 개발 파트너** — 장면에 연결된 대화(스트리밍), 참조 범위(현재 장면 / 원고 전체), 답변을 팀 의견으로 공유,
장면 수정안 생성 → **수정안 검토** 화면에서 원문과 나란히 비교 · 채택 / 보류 / 거절 / 채택 취소 (채택 직전 원고는 작업본에 자동 저장)

**팀 의견** — 장면별 의견, 해결 처리

**작업본** — 원고 스냅샷 저장, 현재 원고와 비교, 되돌리기

**리포트 · 설정** — 작품 정보, 함께 정한 방향(AI가 지키는 원칙), 인물별 대사·등장 통계와 설정, 장면 목록(쪽·분량 1/8), 장소

**가져오기 / 내보내기** — Final Draft `.fdx`, Fountain `.fountain`, PDF(표지 포함 인쇄용 원고)

## 구조

```
shared/   도메인 로직 (요소 규칙, 페이지 계산, Fountain/FDX 변환, 비교, 자동 완성) + 테스트
server/   Express API, SQLite(node:sqlite) 저장소, Claude API 연동(ai.ts)
src/      React 앱 — editor/(TipTap 기반 시나리오 에디터), views/, components/
design/   디자인 시안
```

## 테스트

```bash
npm test        # 도메인 로직 + API
npm run typecheck
```
