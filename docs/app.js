import { GoogleGenAI } from 'https://esm.sh/@google/genai@2.24.0';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@14.1.4/+esm';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.2.4/+esm';

const MODEL = 'gemini-3.8-flash';
const KEY_STORAGE = 'lectly.apiKey';
const view = document.getElementById('view');
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------- storage (IndexedDB, on this device only) ----------
const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open('lectly', 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore('notes', { keyPath: 'id' });
    req.result.createObjectStore('chunks', { keyPath: ['rec', 'seq'] });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function tx(store, mode, fn) {
  return dbReady.then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  }));
}
const getNote = id => tx('notes', 'readonly', s => s.get(id));
const putNote = n => tx('notes', 'readwrite', s => s.put(n));
const deleteNote = id => tx('notes', 'readwrite', s => s.delete(id));
const allNotes = () => tx('notes', 'readonly', s => s.getAll());
const chunkRange = rec => IDBKeyRange.bound([rec, 0], [rec, Infinity]);
const putChunk = (rec, seq, blob) => tx('chunks', 'readwrite', s => s.put({ rec, seq, blob }));
const getChunks = rec => tx('chunks', 'readonly', s => s.getAll(chunkRange(rec)));
const deleteChunks = rec => tx('chunks', 'readwrite', s => s.delete(chunkRange(rec)));

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = s => DOMPurify.sanitize(marked.parse(s || ''));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getKey = () => localStorage.getItem(KEY_STORAGE) || '';
const fmtTime = sec => {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
};
const fmtDate = t => new Date(t).toLocaleString('ko-KR', { month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
const defaultTitle = () => new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' }) + ' 강의';

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2500);
}

function geminiMime(type) {
  const t = (type || '').split(';')[0];
  if (t === 'audio/mp4' || t === 'audio/x-m4a' || t === 'video/mp4' || t === '') return 'audio/m4a';
  if (t === 'video/webm') return 'audio/webm';
  return t;
}

function friendlyError(e) {
  const msg = String(e?.message || e);
  const status = e?.status || Number((msg.match(/\b(4\d\d|5\d\d)\b/) || [])[1]);
  if (status === 429) return '무료 사용량 한도에 걸렸어요. 1~2분 뒤 다시 시도하세요.';
  if (status === 400 && /api key/i.test(msg)) return 'API 키가 올바르지 않아요. 설정에서 다시 입력하세요.';
  if (status === 401 || status === 403) return 'API 키가 올바르지 않아요. 설정에서 다시 입력하세요.';
  if (status >= 500) return 'Google 서버가 잠시 응답하지 않아요. 잠시 뒤 다시 시도하세요.';
  if (/fetch|network/i.test(msg)) return '인터넷 연결을 확인하세요.';
  return msg;
}

// ---------- AI ----------
const TRANSCRIBE_PROMPT = `이 대학 강의 녹음을 빠짐없이 받아쓰기 해줘.
- 요약하지 말고 들리는 말을 그대로 적어. 강의에서 쓴 언어 그대로 적어.
- "어", "음" 같은 군말과 말 더듬기는 빼.
- 주제가 바뀌면 빈 줄로 문단을 나눠.
- 받아쓴 전문만 출력해.`;

const SUMMARY_PROMPT = `아래는 대학 강의 전문과 학생이 강의 중에 쓴 메모야. 시험 공부용 요약 노트를 한국어 마크다운으로 만들어줘.
형식:
# (강의 제목, 20자 이내)
## 한 줄 요약
## 핵심 개념
- **개념**: 설명
## 강의 흐름
1. 순서대로
## 교수님이 강조한 것 / 시험 힌트
## 과제·공지
## 복습 질문
1. 질문 3개

규칙: 전문에 없는 내용은 지어내지 마. 해당 내용이 없는 섹션은 통째로 빼.`;

const processing = new Set();

async function processNote(id) {
  if (processing.has(id)) return;
  const key = getKey();
  let n = await getNote(id);
  if (!key) {
    Object.assign(n, { status: 'error', error: '설정(⚙︎)에서 Gemini API 키를 먼저 입력하세요.' });
    await putNote(n);
    return onNoteChanged(id);
  }
  processing.add(id);
  const step = async label => { n.status = 'processing'; n.step = label; n.error = ''; await putNote(n); onNoteChanged(id); };
  try {
    const ai = new GoogleGenAI({ apiKey: key });
    if (!n.transcript) {
      await step('오디오 올리는 중');
      const mime = geminiMime(n.audioMime);
      let file = await ai.files.upload({ file: n.audio, config: { mimeType: mime, displayName: n.title } });
      while (file.state === 'PROCESSING') {
        await sleep(3000);
        file = await ai.files.get({ name: file.name });
      }
      if (file.state === 'FAILED') throw new Error('Google에서 오디오를 처리하지 못했어요. 파일이 손상됐을 수 있어요.');
      await step('받아쓰는 중 (강의 길이에 따라 몇 분 걸려요)');
      const r = await ai.interactions.create({
        model: MODEL,
        input: [{ type: 'text', text: TRANSCRIBE_PROMPT }, { type: 'audio', uri: file.uri, mime_type: mime }],
      });
      n.transcript = (r.output_text || '').trim();
      ai.files.delete({ name: file.name }).catch(() => {});
      if (!n.transcript) throw new Error('받아쓰기 결과가 비어 있어요. 녹음에 말소리가 있는지 확인하세요.');
      await putNote(n);
    }
    await step('요약하는 중');
    const r = await ai.interactions.create({
      model: MODEL,
      input: `${SUMMARY_PROMPT}\n\n[학생 메모]\n${n.memo || '(없음)'}\n\n[강의 전문]\n${n.transcript}`,
    });
    n.summary = (r.output_text || '').trim();
    const heading = n.summary.match(/^#\s+(.+)$/m);
    if (heading && n.autoTitle) n.title = heading[1].trim();
    Object.assign(n, { status: 'done', step: '', error: '' });
  } catch (e) {
    console.error(e);
    Object.assign(n, { status: 'error', step: '', error: friendlyError(e) });
  } finally {
    processing.delete(id);
    await putNote(n);
    onNoteChanged(id);
  }
}

async function askNote(n, question) {
  const ai = new GoogleGenAI({ apiKey: getKey() });
  const r = await ai.interactions.create({
    model: MODEL,
    input: `아래 강의 전문만 근거로 한국어로 짧게 답해. 전문에 없는 내용이면 "강의에서 다루지 않았어요"라고 해.\n\n[강의 전문]\n${n.transcript}\n\n[질문]\n${question}`,
  });
  return (r.output_text || '').trim();
}

// ---------- recording ----------
let rec = null;

function pickMime() {
  return ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
}

async function keepAwake() {
  try { rec.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}

async function startRecording(subject) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast('마이크 권한이 필요해요. 설정 > Safari > 마이크에서 허용하세요.');
    return false;
  }
  const mime = pickMime();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
  const id = crypto.randomUUID();
  await putNote({
    id, title: defaultTitle(), autoTitle: true, subject, createdAt: Date.now(), durationSec: 0,
    audioMime: recorder.mimeType || mime, memo: '', transcript: '', summary: '', status: 'recording', step: '', error: '',
  });
  let seq = 0;
  const pending = [];
  rec = { id, recorder, stream, pending, startedAt: Date.now(), elapsed: 0, paused: false };
  recorder.ondataavailable = e => { if (e.data.size) pending.push(putChunk(id, seq++, e.data)); };
  recorder.onstop = () => finishRecording();
  stream.getAudioTracks()[0].onended = () => {
    if (rec && rec.recorder.state !== 'inactive') { rec.interrupted = true; rec.recorder.stop(); }
  };
  recorder.start(10000);
  await keepAwake();
  return true;
}

function elapsedSec() {
  if (!rec) return 0;
  return (rec.elapsed + (rec.paused ? 0 : Date.now() - rec.startedAt)) / 1000;
}

function togglePause() {
  if (rec.paused) {
    rec.recorder.resume();
    rec.startedAt = Date.now();
  } else {
    rec.recorder.pause();
    rec.elapsed += Date.now() - rec.startedAt;
  }
  rec.paused = !rec.paused;
}

async function finishRecording() {
  if (!rec || rec.finishing) return;
  rec.finishing = true;
  const { id, stream, wakeLock, pending, interrupted } = rec;
  const durationSec = elapsedSec();
  stream.getTracks().forEach(t => t.stop());
  wakeLock?.release().catch(() => {});
  await Promise.all(pending);
  const n = await getNote(id);
  const memo = document.getElementById('memo');
  if (memo) n.memo = memo.value;
  n.durationSec = durationSec;
  n.audio = await assemble(id, n.audioMime);
  n.status = 'processing';
  await putNote(n);
  await deleteChunks(id);
  rec = null;
  location.hash = '#/note/' + id;
  if (interrupted) toast('마이크가 끊겨 녹음이 멈췄어요. 그 전까지 녹음된 부분을 요약해요.');
  processNote(id);
}

async function assemble(id, mime) {
  const chunks = (await getChunks(id)).sort((a, b) => a.seq - b.seq).map(c => c.blob);
  return new Blob(chunks, { type: mime });
}

// a recording or processing run interrupted by a crash, reload or iOS killing the tab
async function recoverInterrupted() {
  for (const n of await allNotes()) {
    if (n.status === 'processing') {
      Object.assign(n, { status: 'error', step: '', error: '처리 도중 앱이 닫혔어요. 녹음은 그대로 있으니 "다시 시도"를 누르세요.' });
      await putNote(n);
      continue;
    }
    if (n.status !== 'recording' || n.id === rec?.id) continue;
    n.audio = await assemble(n.id, n.audioMime);
    if (!n.audio.size) { await deleteNote(n.id); await deleteChunks(n.id); continue; }
    Object.assign(n, { status: 'error', error: '녹음이 중간에 끊겼어요. 저장된 부분까지는 남아 있어요. "다시 시도"를 누르면 요약해요.' });
    await putNote(n);
    await deleteChunks(n.id);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!rec) return;
  if (document.visibilityState === 'hidden') rec.leftApp = true;
  else {
    keepAwake();
    if (IS_IOS && rec.leftApp) toast('다른 앱에 있는 동안은 아이폰이 녹음을 멈춰요. 다음엔 음성 메모를 쓰세요.');
    rec.leftApp = false;
  }
});

// recording keeps going while you move around inside Lectly
const recbar = document.getElementById('recbar');
setInterval(() => {
  recbar.hidden = !rec || location.hash === '#/record';
  if (rec) document.getElementById('recbar-time').textContent = fmtTime(elapsedSec());
}, 500);
window.addEventListener('beforeunload', e => { if (rec) e.preventDefault(); });

// ---------- screens ----------
let listFilter = { subject: '', q: '' };
let noteTab = 'summary';
const chats = new Map();

async function renderList() {
  const notes = (await allNotes()).sort((a, b) => b.createdAt - a.createdAt);
  const subjects = [...new Set(notes.map(n => n.subject).filter(Boolean))];
  view.innerHTML = `
    ${!getKey() ? `<p class="notice">처음이시면 <a href="#/settings">설정</a>에서 무료 Gemini API 키를 먼저 넣어주세요.</p>` : ''}
    <div class="stack">
      ${IS_IOS ? `
        <label class="btn primary big" style="display:block;text-align:center">
          🎙 음성 메모 파일 올리기
          <input type="file" id="file" accept="audio/*,.m4a,.mp3,.wav" hidden>
        </label>
        <details class="notice">
          <summary><b>음성 메모로 녹음하는 법</b> (다른 앱을 써도, 화면을 잠가도 계속 녹음돼요)</summary>
          <ol>
            <li>아이폰 <b>음성 메모</b> 앱에서 빨간 버튼으로 녹음</li>
            <li>끝나면 그 녹음을 누르고 <b>···</b> → <b>공유</b> → <b>파일에 저장</b></li>
            <li>Lectly에서 <b>음성 메모 파일 올리기</b> → 방금 저장한 파일 선택</li>
          </ol>
        </details>
        <a class="btn" href="#/record" style="display:block;text-align:center">● Lectly에서 바로 녹음 (화면을 켜둘 때만)</a>`
      : `
        <a class="btn primary big" href="#/record" style="text-align:center">● 강의 녹음 시작</a>
        <label class="btn" style="display:block;text-align:center">
          음성 파일 올리기
          <input type="file" id="file" accept="audio/*,.m4a,.mp3,.wav" hidden>
        </label>`}
      <input type="search" id="q" placeholder="노트 검색 (제목, 내용)" value="${esc(listFilter.q)}">
      ${subjects.length ? `<div class="chips">
        <button class="chip ${!listFilter.subject ? 'on' : ''}" data-subject="">전체</button>
        ${subjects.map(s => `<button class="chip ${listFilter.subject === s ? 'on' : ''}" data-subject="${esc(s)}">${esc(s)}</button>`).join('')}
      </div>` : ''}
      <div id="list"></div>
    </div>`;
  const fill = () => {
    const q = listFilter.q.toLowerCase();
    const shown = notes.filter(n =>
      (!listFilter.subject || n.subject === listFilter.subject) &&
      (!q || [n.title, n.subject, n.memo, n.transcript, n.summary].join(' ').toLowerCase().includes(q)));
    document.getElementById('list').innerHTML = shown.length ? shown.map(n => `
      <a class="card" href="#/note/${n.id}">
        <div class="row" style="justify-content:space-between">
          <span class="title">${esc(n.title)}</span>
          ${n.status === 'processing' ? '<span class="badge">처리 중</span>' : ''}
          ${n.status === 'error' ? '<span class="badge error">확인 필요</span>' : ''}
          ${n.status === 'recording' ? '<span class="badge error">녹음 중</span>' : ''}
        </div>
        <div class="muted">${esc(n.subject || '과목 없음')} · ${fmtDate(n.createdAt)}${n.durationSec ? ' · ' + fmtTime(n.durationSec) : ''}</div>
      </a>`).join('')
      : `<div class="empty">${notes.length ? '검색 결과가 없어요.' : '아직 노트가 없어요.<br>첫 강의를 녹음해 보세요.'}</div>`;
  };
  fill();
  document.getElementById('q').oninput = e => { listFilter.q = e.target.value; fill(); };
  view.querySelectorAll('[data-subject]').forEach(b => b.onclick = () => { listFilter.subject = b.dataset.subject; renderList(); });
  document.getElementById('file').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    const id = crypto.randomUUID();
    await putNote({
      id, title: f.name.replace(/\.[^.]+$/, ''), autoTitle: true, subject: listFilter.subject, createdAt: Date.now(), durationSec: 0,
      audio: f, audioMime: f.type || 'audio/m4a', memo: '', transcript: '', summary: '', status: 'processing', step: '', error: '',
    });
    location.hash = '#/note/' + id;
    processNote(id);
  };
  renderList.fill = fill;
}

async function renderRecord() {
  if (!rec) {
    const subjects = [...new Set((await allNotes()).map(n => n.subject).filter(Boolean))];
    view.innerHTML = `
      <h1>새 강의 녹음</h1>
      <div class="stack">
        <div>
          <label for="subject">과목</label>
          <input type="text" id="subject" list="subjects" placeholder="예: 경제학원론" value="${esc(listFilter.subject)}">
          <datalist id="subjects">${subjects.map(s => `<option value="${esc(s)}">`).join('')}</datalist>
        </div>
        <button class="primary big" id="start">● 녹음 시작</button>
        ${IS_IOS
          ? `<p class="notice">아이폰에서는 <b>이 화면을 켜둔 동안만</b> 녹음돼요. 다른 앱으로 가거나 화면이 잠기면 애플 정책상 녹음이 멈춰요.
             다른 앱을 쓸 거라면 <a href="#/">음성 메모로 녹음</a>하세요. 끊겨도 10초 단위로 저장된 부분은 남아요.</p>`
          : `<p class="notice">녹음 중에 <b>다른 탭이나 앱으로 가도 계속 녹음돼요.</b> Lectly 탭만 닫지 마세요.
             맥북 덮개를 닫으면(잠자기) 멈추니, 긴 강의는 전원을 연결해 두세요.</p>`}
      </div>`;
    document.getElementById('start').onclick = async () => {
      const ok = await startRecording(document.getElementById('subject').value.trim());
      if (ok) renderRecord();
    };
    return;
  }
  const n = await getNote(rec.id);
  view.innerHTML = `
    <p class="muted" style="text-align:center">${esc(n.subject || '과목 없음')}</p>
    <div class="timer" id="timer">${fmtTime(elapsedSec())}</div>
    <p class="muted" style="text-align:center" id="state">${rec.paused ? '일시정지됨' : '<span class="dot"></span>녹음 중'}</p>
    <div class="stack">
      <div class="row" style="justify-content:center">
        <button id="pause">${rec.paused ? '▶ 이어서' : 'Ⅱ 일시정지'}</button>
        <button class="primary" id="stop">■ 종료하고 요약</button>
      </div>
      <div>
        <label for="memo">내 메모 (요약할 때 함께 반영돼요)</label>
        <textarea id="memo" placeholder="예: 여기 시험에 나온다고 함!">${esc(n.memo)}</textarea>
      </div>
    </div>`;
  const memo = document.getElementById('memo');
  memo.oninput = async () => { const cur = await getNote(n.id); cur.memo = memo.value; putNote(cur); };
  document.getElementById('pause').onclick = () => { togglePause(); renderRecord(); };
  document.getElementById('stop').onclick = e => { e.target.disabled = true; rec.recorder.stop(); };
  clearInterval(renderRecord.tick);
  renderRecord.tick = setInterval(() => {
    const t = document.getElementById('timer');
    if (!t || !rec) return clearInterval(renderRecord.tick);
    t.textContent = fmtTime(elapsedSec());
  }, 500);
}

async function renderNote(id) {
  const n = await getNote(id);
  if (!n) { view.innerHTML = '<div class="empty">노트를 찾을 수 없어요. <a href="#/">목록으로</a></div>'; return; }
  const audioUrl = n.audio ? URL.createObjectURL(n.audio) : '';
  const chat = chats.get(id) || [];
  const body = {
    summary: n.summary ? `<div class="md">${md(n.summary)}</div>` : '<p class="muted">요약이 아직 없어요.</p>',
    transcript: n.transcript ? `
      <textarea id="transcript" style="min-height:50vh">${esc(n.transcript)}</textarea>
      <div class="row" style="margin-top:8px">
        <button id="saveT">전문 저장</button>
        <button id="resummarize">이 전문으로 요약 다시 만들기</button>
      </div>` : '<p class="muted">전문이 아직 없어요.</p>',
    ask: n.transcript ? `
      <div class="chat">${chat.map(c => `<p class="q">Q. ${esc(c.q)}</p><div class="md">${md(c.a)}</div>`).join('')}</div>
      <form id="askForm" class="row" style="margin-top:12px">
        <input type="text" id="question" placeholder="예: 수요의 가격탄력성이 뭐였지?" style="flex:1">
        <button class="primary">질문</button>
      </form>` : '<p class="muted">전문이 생기면 질문할 수 있어요.</p>',
  }[noteTab];
  view.innerHTML = `
    <div class="stack">
      <input type="text" id="title" value="${esc(n.title)}" aria-label="제목" style="font-size:20px;font-weight:700">
      <input type="text" id="subj" value="${esc(n.subject)}" placeholder="과목" aria-label="과목">
      <p class="muted">${fmtDate(n.createdAt)}${n.durationSec ? ' · ' + fmtTime(n.durationSec) : ''}</p>
      ${n.status === 'processing' ? `<p class="notice">⏳ ${esc(n.step || '준비 중')}… 화면을 나가도 되지만, Lectly는 닫지 마세요.</p>` : ''}
      ${n.status === 'error' ? `<div class="notice error">${esc(n.error)}<div style="margin-top:8px"><button id="retry">다시 시도</button></div></div>` : ''}
      ${audioUrl ? `<audio controls src="${audioUrl}"></audio>` : ''}
      ${n.memo ? `<details><summary class="muted">내 메모</summary><p class="transcript">${esc(n.memo)}</p></details>` : ''}
    </div>
    <div class="tabs">
      <button data-tab="summary" class="${noteTab === 'summary' ? 'on' : ''}">요약</button>
      <button data-tab="transcript" class="${noteTab === 'transcript' ? 'on' : ''}">전문</button>
      <button data-tab="ask" class="${noteTab === 'ask' ? 'on' : ''}">질문하기</button>
    </div>
    ${body}
    <div class="row" style="margin-top:24px;justify-content:space-between">
      <button id="copy" ${n.summary || n.transcript ? '' : 'disabled'}>요약+전문 복사</button>
      <button class="danger" id="del">삭제</button>
    </div>`;

  const save = async patch => { const cur = await getNote(id); Object.assign(cur, patch); await putNote(cur); };
  document.getElementById('title').onchange = e => save({ title: e.target.value.trim() || n.title, autoTitle: false });
  document.getElementById('subj').onchange = e => save({ subject: e.target.value.trim() });
  view.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { noteTab = b.dataset.tab; renderNote(id); });
  document.getElementById('retry')?.addEventListener('click', () => processNote(id));
  document.getElementById('saveT')?.addEventListener('click', async () => {
    await save({ transcript: document.getElementById('transcript').value });
    toast('전문을 저장했어요');
  });
  document.getElementById('resummarize')?.addEventListener('click', async () => {
    await save({ transcript: document.getElementById('transcript').value });
    noteTab = 'summary';
    processNote(id);
  });
  document.getElementById('askForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const input = document.getElementById('question');
    const q = input.value.trim();
    if (!q) return;
    input.disabled = true;
    try {
      const a = await askNote(n, q);
      chats.set(id, [...chat, { q, a }]);
      renderNote(id);
    } catch (err) {
      toast(friendlyError(err));
      input.disabled = false;
    }
  });
  document.getElementById('copy').onclick = async () => {
    await navigator.clipboard.writeText(`${n.summary || ''}\n\n---\n전문\n\n${n.transcript || ''}`);
    toast('복사했어요. 메모 앱이나 노션에 붙여넣으세요.');
  };
  document.getElementById('del').onclick = async () => {
    if (!confirm('이 노트를 삭제할까요? 되돌릴 수 없어요.')) return;
    await deleteNote(id);
    location.hash = '#/';
  };
}

function renderSettings() {
  view.innerHTML = `
    <h1>설정</h1>
    <div class="stack">
      <div>
        <label for="key">Gemini API 키</label>
        <input type="password" id="key" value="${esc(getKey())}" placeholder="AIza…" autocomplete="off">
      </div>
      <button class="primary" id="saveKey">저장</button>
      <div class="notice">
        <b>무료 키 받는 법 (2분)</b>
        <ol>
          <li><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>에 구글 계정으로 로그인</li>
          <li>"Create API key" 누르기</li>
          <li>나온 키를 복사해서 위에 붙여넣고 저장</li>
        </ol>
        키는 이 기기에만 저장돼요. 결제 수단을 등록하지 않으면 요금이 나오지 않아요.
        단, 무료 등급으로 보낸 녹음은 Google이 서비스 개선에 쓸 수 있어요.
      </div>
      <p class="muted">노트는 이 기기의 브라우저에만 저장돼요. Safari 방문 기록·웹사이트 데이터를 지우면 노트도 지워지니, 중요한 노트는 "복사"로 백업하세요.</p>
    </div>`;
  document.getElementById('saveKey').onclick = () => {
    localStorage.setItem(KEY_STORAGE, document.getElementById('key').value.trim());
    toast('저장했어요');
    location.hash = '#/';
  };
}

// ---------- routing ----------
function route() {
  const h = location.hash || '#/';
  if (h.startsWith('#/note/')) return renderNote(h.slice(7));
  if (h === '#/record') return renderRecord();
  if (h === '#/settings') return renderSettings();
  return renderList();
}

function onNoteChanged(id) {
  const h = location.hash || '#/';
  if (h === '#/note/' + id) renderNote(id);
  else if (h === '#/' && renderList.fill) renderList();
}

window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/note/')) noteTab = 'summary'; route(); });
await recoverInterrupted();
route();
