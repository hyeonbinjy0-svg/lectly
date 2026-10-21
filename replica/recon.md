# Recon: Flownote - AI Note Taker (iOS)

Scope: 개인용 대학 강의 요약. 핵심 루프만: **녹음 → 받아쓰기 → AI 요약 → 과목별 보관/검색**.
Platform: 원본은 iOS 앱. 클론은 아이폰 Safari에서 홈 화면에 추가해 쓰는 웹앱(PWA).
비용 조건: 0원 (호스팅·DB·AI 모두 무료).

## Sources

| source | url | 얻은 것 |
| --- | --- | --- |
| App Store listing | https://apps.apple.com/us/app/id6501961836 | 기능 목록, 구독 가격대, 리뷰 |
| AppFollow tracker | https://apps.appfollow.io/ios/flownote-ai-note-taker/6501961836?country=us | 평점 4.8 / 리뷰 약 2.4k, v1.8 |
| 사용자 본인 계정 | (미사용) | 필요 시 스크린샷으로 보강 |

## Screens

| ID | screen | 진입 | purpose | key components | states |
| --- | --- | --- | --- | --- | --- |
| S01 | 노트 목록 | 앱 시작 | 노트 찾기 | 검색창, 폴더(과목) 필터, 노트 카드, 녹음 버튼 | empty, filled, 검색 결과 없음 |
| S02 | 녹음 | S01 녹음 버튼 | 강의 녹음 | 타이머, 일시정지/종료, 내 메모 입력 | 녹음중, 일시정지, 마이크 권한 거부 |
| S03 | 처리중 | S02 종료 / 파일 업로드 | 받아쓰기·요약 생성 | 진행 단계 표시 | 업로드중, 받아쓰는중, 요약중, 실패(재시도) |
| S04 | 노트 상세 | S01 카드 | 요약/전문 보기 | 요약 탭, 전문 탭(편집), 질문하기, 복사 | 처리중, 완료, 실패 |
| S05 | 설정 | S01 톱니바퀴 | API 키 입력 | 키 입력, 저장 | 키 없음, 키 있음 |

## Flows

```
F01 강의 녹음해서 요약 받기
    S01 -> S02 (녹음, 메모) -> S03 -> S04 요약
    happy path: 녹음 1탭 + 종료 1탭 = 2탭
    edge: 마이크 권한 거부, 화면 꺼짐으로 녹음 중단, 앱 종료/새로고침, 네트워크 실패
F02 음성 메모 파일로 요약 받기
    S01 파일 업로드 -> S03 -> S04
F03 지난 강의 찾기
    S01 검색/과목 필터 -> S04
F04 노트에 질문하기
    S04 질문 입력 -> 답변
F05 받아쓰기 오류 고치기
    S04 전문 탭 편집 -> 저장 -> (선택) 요약 다시 만들기
```

## Components

버튼(primary/secondary/danger), 텍스트 입력, 텍스트영역, 노트 카드, 탭, 칩(과목 필터), 상태 배지, 토스트, 상단 바.

## Inferred data model

```
Note  id, title, subject, created_at, duration_sec, audio (blob), audio_mime,
      my_memo, transcript, summary, status (recording|processing|done|error), error
      evidence: 리스팅 "folders", "search", "AI summaries", "transcription"
      confidence: high
Chunk recording_id, seq, blob   (클론 전용: 녹음 중 10초마다 저장해 유실 방지)
```

## Out of scope (skip)

- 화자 구분 표시: 강의는 대부분 1인 화자. 필요하면 프롬프트로 가능.
- Zoom/Meet/Teams 연동: 강의 요약에 불필요.
- 팀 공유: 개인용.
- 구독 결제: 개인용, 무료.
- 기기 간 동기화: 무료·단순성을 위해 기기 내 저장만. (내보내기는 복사로 대체)

## 원본 사용자 불만 (App Store 리뷰) → 클론에서 고칠 점

1. 녹음이 사라지거나 "processing"에서 멈춤 → 오디오를 기기에 보관, 실패 시 재시도 버튼.
2. 강의 중 녹음이 멈춰 5시간 분량 유실 → 10초마다 조각 저장 + 화면 꺼짐 방지(Wake Lock) + 다음 실행 때 복구.
3. 받아쓰기 수정 불가 → 전문 편집 가능.
4. 녹음 중 내 메모를 쓰고 싶음 → 녹음 화면에 메모 칸.
5. 무료 체험 후 연간 결제 → 해당 없음 (무료).

## Size

화면 5, 흐름 5, 엔티티 1(+조각). 어려운 부분: 아이폰 Safari 장시간 녹음, 긴 오디오 업로드, AI 응답 처리.
크기: **S** (개인용 MVP).
