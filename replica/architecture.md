# Architecture

목표: 개발 경험 없이 유지할 수 있고, 비용 0원.

| 부분 | 선택 | 이유 |
| --- | --- | --- |
| 앱 | HTML + CSS + JS 파일 3개 (빌드 도구 없음) | 설치할 것이 없고, 파일만 올리면 끝 |
| 저장 | 브라우저 IndexedDB (기기 내) | 무료, 서버/DB 계정 불필요, 오프라인 |
| AI | Google Gemini API 무료 등급, `gemini-3.8-flash` | 오디오를 직접 받아 받아쓰기+요약, 한국어 지원, 무료 |
| SDK | `@google/genai@2.24.0` (jsDelivr CDN) | 대용량 파일 업로드를 SDK가 처리 |
| 호스팅 | GitHub Pages (무료, HTTPS) | 아이폰에서 마이크는 HTTPS 필요 |

Supabase/Next.js는 쓰지 않음: 개인용·단일 기기에서는 이득 없이 복잡도만 늘어남.

## 처리 순서

1. 녹음: MediaRecorder, 10초마다 조각을 IndexedDB `chunks`에 저장. Wake Lock으로 화면 유지.
2. 종료: 조각을 합쳐 노트에 오디오 저장, 조각 삭제.
3. 업로드: `ai.files.upload` → 상태가 ACTIVE가 될 때까지 대기.
4. 받아쓰기: interactions 호출 1 (오디오 → 전문).
5. 요약: interactions 호출 2 (전문 + 내 메모 → 마크다운 요약).
6. 실패하면 status=error, 오디오는 남아 있어 재시도 가능.

## 주의

- 무료 등급에 보낸 내용은 Google이 제품 개선에 사용할 수 있음.
- API 키는 사용자의 기기(localStorage)에만 저장. 코드에 넣지 않음.
- 노트는 기기별로 저장됨(아이폰과 노트북 간 동기화 없음).
