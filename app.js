'use strict';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const SESSION_SIZE    = 20;
const STORAGE_KEY     = 'study-app-progress';
const SETTINGS_KEY    = 'study-app-settings';
const GITHUB_KEY      = 'study-app-github';
const GIST_FILENAME   = 'study-progress.json';
// Bump this AND version.json AND the ?v= query param on the app.js
// <script> tag in index.html together on every deploy — the query
// param is what actually busts the browser's HTTP cache for this file.
const APP_VERSION     = '2026-07-21T12:00:00Z';
const INSTALL_TIP_KEY = 'study-app-install-dismissed';

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
const state = {
  lists:          [],
  currentList:    null,
  currentMode:    null,
  progress:       {},
  settings:       { autoAdvanceDelay: 1000, examMode: false },
  // MCQ Quiz state
  mcqSession:        [],
  mcqIndex:          0,
  mcqResults:        {},
  mcqChoices:        {},
  mcqGradeMode:      'inline',
  mcqDirection:      null,
  mcqAdvanceTimeout: null,
  // Translate mode state
  translateSession:   [],
  translateIndex:     0,
  translateResults:   [],
  translateDirection: 'mix',
  // Flashcard mode state
  flashcardSession: [],
  flashcardIndex:   0,
  flashcardResults: [],
  flashcardFlipped: false,
};

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────
function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function listLabels() {
  return state.currentList?.labels ?? { front: 'Spanish', back: 'English' };
}

function updateSubjectLabels() {
  const list          = state.currentList;
  const isMcQuiz      = list.type === 'quiz';
  const isTranslate   = list.type === 'translate';
  const isFlashcard   = list.type === 'flashcard';
  const isDirectional = isMcQuiz && list.directional === true;
  const hasSummaries  = list.summaries && Object.keys(list.summaries).length > 0;
  const hasTerms      = Array.isArray(list.terms) && list.terms.length > 0;

  document.getElementById('btn-flashcards').classList.toggle('hidden', !isFlashcard);
  document.getElementById('btn-mc-quiz').classList.toggle('hidden',    !isMcQuiz || isDirectional);
  document.getElementById('btn-mcq-es-en').classList.toggle('hidden',  !isDirectional);
  document.getElementById('btn-mcq-en-es').classList.toggle('hidden',  !isDirectional);
  document.getElementById('btn-translate-es-en').classList.toggle('hidden', !isTranslate);
  document.getElementById('btn-translate-en-es').classList.toggle('hidden', !isTranslate);
  document.getElementById('btn-translate-mix').classList.toggle('hidden',   !isTranslate);
  document.getElementById('btn-all-terms').classList.toggle('hidden',  !hasTerms);
  document.getElementById('btn-reference').classList.toggle('hidden',  !hasSummaries);

  const grid = document.getElementById('mode-grid');
  grid.classList.remove('mode-grid--one', 'mode-grid--two', 'mode-grid--three');
  if (isTranslate)         grid.classList.add('mode-grid--three');
  else if (isDirectional)  grid.classList.add('mode-grid--two');
  else                     grid.classList.add('mode-grid--one');

  const { front, back } = listLabels();

  const esEnBtn = document.getElementById('btn-mcq-es-en');
  const enEsBtn = document.getElementById('btn-mcq-en-es');
  if (esEnBtn) esEnBtn.querySelector('.mode-desc').textContent = `${front} → ${back}`;
  if (enEsBtn) enEsBtn.querySelector('.mode-desc').textContent = `${back} → ${front}`;

  const thFront = document.getElementById('browse-sort-es');
  const thBack  = document.getElementById('browse-sort-en');
  if (thFront) thFront.innerHTML = `${front} <span class="sort-indicator">↕</span>`;
  if (thBack)  thBack.innerHTML  = `${back} <span class="sort-indicator">↕</span>`;

  const statFront = document.getElementById('stats-col-front');
  const statBack  = document.getElementById('stats-col-back');
  if (statFront) statFront.textContent = front;
  if (statBack)  statBack.textContent  = back;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─────────────────────────────────────────────
// Progress — localStorage (primary) + IndexedDB (backup)
// ─────────────────────────────────────────────
const IDB_NAME    = 'study-app-db';
const IDB_VERSION = 1;
const IDB_STORE   = 'progress';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess       = e => resolve(e.target.result);
    req.onerror         = e => reject(e.target.error);
  });
}

function idbSave(data) {
  idbOpen()
    .then(db => db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(data, 'main'))
    .catch(() => {});
}

function idbLoad() {
  return new Promise(resolve => {
    idbOpen()
      .then(db => {
        const req     = db.transaction(IDB_STORE).objectStore(IDB_STORE).get('main');
        req.onsuccess = e => resolve(e.target.result ?? null);
        req.onerror   = ()  => resolve(null);
      })
      .catch(() => resolve(null));
  });
}

async function loadProgress() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) { state.progress = JSON.parse(stored); return; }
  } catch {}

  try {
    const backup = await idbLoad();
    if (backup && typeof backup === 'object') {
      state.progress = backup;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(backup));
      return;
    }
  } catch {}

  try {
    const gistData = await gistFetch();
    if (gistData) {
      state.progress = gistData;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(gistData));
      idbSave(gistData);
      return;
    }
  } catch {}

  state.progress = {};
}

function saveProgress() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
  idbSave(state.progress);
  gistSync();
}

// ─────────────────────────────────────────────
// GitHub Gist sync
// ─────────────────────────────────────────────
function loadGithubSettings() {
  try { return JSON.parse(localStorage.getItem(GITHUB_KEY) || 'null') || {}; }
  catch { return {}; }
}

function saveGithubSettings(settings) {
  localStorage.setItem(GITHUB_KEY, JSON.stringify(settings));
}

async function gistRequest(method, path, body) {
  const gh  = loadGithubSettings();
  if (!gh.token) return null;
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Authorization': `token ${gh.token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/vnd.github+json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res.json();
}

async function gistSync() {
  const gh    = loadGithubSettings();
  if (!gh.token) return;
  const files = { [GIST_FILENAME]: { content: JSON.stringify(state.progress) } };
  try {
    if (gh.gistId) {
      await gistRequest('PATCH', `/gists/${gh.gistId}`, { files });
    } else {
      const data = await gistRequest('POST', '/gists', {
        description: 'Study App Progress Backup',
        public: false,
        files,
      });
      saveGithubSettings({ ...gh, gistId: data.id });
    }
    saveGithubSettings({ ...loadGithubSettings(), lastSync: Date.now() });
    updateGithubStatus();
  } catch {
    updateGithubStatus('error');
  }
}

async function gistFetch() {
  const gh = loadGithubSettings();
  if (!gh.token || !gh.gistId) return null;
  const data    = await gistRequest('GET', `/gists/${gh.gistId}`);
  const content = data?.files?.[GIST_FILENAME]?.content;
  return content ? JSON.parse(content) : null;
}

async function connectGithub() {
  const token = document.getElementById('github-token-input').value.trim();
  if (!token) return;
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error('Invalid token');
    const user = await res.json();
    saveGithubSettings({ token, gistId: null, user: user.login });
    document.getElementById('github-token-input').value = '';
    closeGithubPanel();
    await gistSync();
    updateGithubStatus();
  } catch {
    document.getElementById('github-token-error').classList.remove('hidden');
  }
}

function disconnectGithub() {
  localStorage.removeItem(GITHUB_KEY);
  closeGithubPanel();
  updateGithubStatus();
}

function openGithubPanel() {
  const panel = document.getElementById('github-panel');
  const gh    = loadGithubSettings();
  panel.classList.remove('hidden');
  document.getElementById('github-token-error').classList.add('hidden');
  document.getElementById('github-disconnect-btn').classList.toggle('hidden', !gh.token);
  if (!gh.token) document.getElementById('github-token-input').focus();
}

function closeGithubPanel() {
  document.getElementById('github-panel').classList.add('hidden');
}

function updateGithubStatus() {
  const gh  = loadGithubSettings();
  const btn = document.getElementById('github-sync-btn');
  if (!btn) return;
  if (!gh.token) {
    btn.textContent = '☁ GitHub Sync';
    btn.classList.remove('github-sync-btn--ok', 'github-sync-btn--err');
    return;
  }
  if (gh.lastSync) {
    const mins = Math.round((Date.now() - gh.lastSync) / 60000);
    const ago  = mins < 1 ? 'just now' : `${mins}m ago`;
    btn.textContent = `☁ ${gh.user} · ${ago}`;
    btn.classList.add('github-sync-btn--ok');
    btn.classList.remove('github-sync-btn--err');
  } else {
    btn.textContent = '☁ Sync error';
    btn.classList.add('github-sync-btn--err');
    btn.classList.remove('github-sync-btn--ok');
  }
}

// ─────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    state.settings = { autoAdvanceDelay: 1000, examMode: false, ...saved };
  } catch {
    state.settings = { autoAdvanceDelay: 1000, examMode: false };
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function setAutoAdvanceDelay(value) {
  state.settings.autoAdvanceDelay = parseInt(value, 10);
  saveSettings();
  updateAutoAdvanceUI();
}

function updateAutoAdvanceUI() {
  const value   = state.settings.autoAdvanceDelay.toString();
  const select1 = document.getElementById('auto-advance-select');
  const select2 = document.getElementById('quiz-auto-advance-select');
  if (select1) select1.value = value;
  if (select2) select2.value = value;
}

function setExamMode(checked) {
  state.settings.examMode = checked;
  saveSettings();
  updateExamModeUI();
}

function updateExamModeUI() {
  const checkbox = document.getElementById('exam-mode-checkbox');
  if (checkbox) checkbox.checked = !!state.settings.examMode;
}

// ─────────────────────────────────────────────
// Screen navigation
// ─────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.getElementById('picker-bar').classList.toggle('hidden', !state.currentList);
  closeAllPickers();
}

function showQuizMode(mode) {
  document.querySelectorAll('.quiz-mode').forEach(el => el.classList.add('hidden'));
  document.getElementById('mode-' + mode).classList.remove('hidden');
}

function goHome() {
  showScreen('screen-home');
}

function switchTab(name) {
  const statsTab  = document.getElementById('tab-stats');
  const statsTile = document.getElementById('tile-stats');

  if (name === 'stats') {
    const opening = statsTab.classList.contains('hidden');
    statsTab.classList.toggle('hidden', !opening);
    statsTile.classList.toggle('active', opening);
    if (opening) renderStats();
  }
}

function closeTabs() {
  document.getElementById('tab-stats').classList.add('hidden');
  document.getElementById('tile-stats').classList.remove('active');
}

function confirmQuit() {
  showScreen('screen-mode');
}

// ─────────────────────────────────────────────
// Home screen
// ─────────────────────────────────────────────
async function init() {
  await loadProgress();
  loadSettings();
  updateGithubStatus();
  setupEventListeners();
  updateAutoAdvanceUI();
  updateExamModeUI();
  checkForUpdate();

  try {
    const res  = await fetch('data/index.json');
    const data = await res.json();
    state.lists = data.lists.filter(l => !l.hidden).sort((a, b) => b.created.localeCompare(a.created));
    buildClassPicker();

    if (state.lists.length > 0) {
      const firstClass = state.lists[0].subject;
      selectedClass = firstClass;
      buildUnitPicker(firstClass);
      updateClassHighlight();
      await selectList(state.lists[0]);
    } else {
      showScreen('screen-home');
    }
  } catch {
    showScreen('screen-home');
    document.getElementById('lists-container').innerHTML =
      '<p class="muted-text">Could not load lists.<br>Open via GitHub Pages or a local server (not directly from the filesystem).</p>';
  }
}

function computeListProgress(listId, wordCount, type) {
  if (wordCount === 0 || !state.progress[listId]) return 0;
  if (type === 'quiz') {
    const records = Object.values(state.progress[listId]);
    if (records.length === 0) return 0;
    const mastered = records.filter(r => {
      const total = r.correct + r.incorrect;
      return total > 0 && r.correct / total >= 0.8;
    }).length;
    return Math.round((mastered / wordCount) * 100);
  }
  return 0;
}

// ─────────────────────────────────────────────
// Class + Unit pickers
// ─────────────────────────────────────────────
let selectedClass = null;

function buildClassPicker() {
  const classes  = [...new Set(state.lists.map(l => l.subject))];
  const dropdown = document.getElementById('class-picker-dropdown');
  dropdown.innerHTML = '';

  for (const cls of classes) {
    const btn = document.createElement('button');
    btn.className       = 'list-picker-option';
    btn.textContent     = cls;
    btn.dataset.subject = cls;
    btn.addEventListener('click', () => { closeAllPickers(); switchClass(cls); });
    dropdown.appendChild(btn);
  }
}

function buildUnitPicker(subject) {
  const lists    = state.lists.filter(l => l.subject === subject).slice();
  const dropdown = document.getElementById('unit-picker-dropdown');
  dropdown.innerHTML = '';

  for (const list of lists) {
    const btn = document.createElement('button');
    btn.className   = 'list-picker-option';
    btn.textContent = list.name;
    btn.dataset.id  = list.id;
    btn.addEventListener('click', () => { closeAllPickers(); selectList(list); });
    dropdown.appendChild(btn);
  }
}

function switchClass(cls) {
  selectedClass = cls;
  buildUnitPicker(cls);
  updateClassHighlight();
  const first = state.lists.find(l => l.subject === cls);
  if (first) selectList(first);
}

function updatePickerLabels() {
  const list = state.currentList;
  document.getElementById('class-picker-value').textContent = list.subject;
  document.getElementById('unit-picker-value').textContent  = list.name;
  updateClassHighlight();
  document.querySelectorAll('#unit-picker-dropdown .list-picker-option').forEach(btn => {
    btn.classList.toggle('current', btn.dataset.id === list.id);
  });
}

function updateClassHighlight() {
  document.querySelectorAll('#class-picker-dropdown .list-picker-option').forEach(btn => {
    btn.classList.toggle('current', btn.dataset.subject === selectedClass);
  });
}

function toggleClassPicker() {
  const isOpen = document.getElementById('class-picker').classList.contains('open');
  closeAllPickers();
  if (!isOpen) {
    document.getElementById('class-picker').classList.add('open');
    document.getElementById('class-picker-dropdown').classList.remove('hidden');
  }
}

function toggleUnitPicker() {
  const isOpen = document.getElementById('unit-picker').classList.contains('open');
  closeAllPickers();
  if (!isOpen) {
    document.getElementById('unit-picker').classList.add('open');
    document.getElementById('unit-picker-dropdown').classList.remove('hidden');
  }
}

function closeAllPickers() {
  ['class-picker', 'unit-picker'].forEach(id => {
    document.getElementById(id).classList.remove('open');
    document.getElementById(id + '-dropdown').classList.add('hidden');
  });
}

function renderHome() {
  const container = document.getElementById('lists-container');
  container.innerHTML = '';

  const bySubject = {};
  for (const list of state.lists) {
    if (!bySubject[list.subject]) bySubject[list.subject] = [];
    bySubject[list.subject].push(list);
  }

  for (const [subject, lists] of Object.entries(bySubject)) {
    const section  = document.createElement('div');
    section.className = 'subject-section';

    const heading = document.createElement('h2');
    heading.className   = 'subject-title';
    heading.textContent = subject;
    section.appendChild(heading);

    for (const meta of lists) {
      const pct  = computeListProgress(meta.id, meta.wordCount, meta.type);
      const card = document.createElement('button');
      card.className = 'list-card';

      const info  = document.createElement('div');
      info.className = 'list-card-info';

      const name  = document.createElement('span');
      name.className   = 'list-name';
      name.textContent = meta.name;

      const count = document.createElement('span');
      count.className   = 'list-meta';
      count.textContent = meta.type === 'quiz'
        ? `${meta.wordCount} questions`
        : meta.type === 'translate'
          ? `${meta.wordCount} sentences`
          : meta.type === 'flashcard'
            ? `${meta.wordCount} cards`
            : `${meta.wordCount} items`;

      info.appendChild(name);
      info.appendChild(count);

      const bar  = document.createElement('div');
      bar.className = 'list-progress-bar';
      const fill = document.createElement('div');
      fill.className    = 'list-progress-fill';
      fill.style.width  = pct + '%';
      bar.appendChild(fill);

      card.appendChild(info);
      card.appendChild(bar);
      card.addEventListener('click', () => selectList(meta));
      section.appendChild(card);
    }

    container.appendChild(section);
  }
}

// ─────────────────────────────────────────────
// Mode selection
// ─────────────────────────────────────────────
async function selectList(meta) {
  try {
    const res = await fetch(meta.file);
    state.currentList = await res.json();
  } catch {
    alert('Could not load that list. Try again.');
    return;
  }

  if (state.currentList.subject !== selectedClass) {
    selectedClass = state.currentList.subject;
    buildUnitPicker(selectedClass);
  }
  updatePickerLabels();
  updateSubjectLabels();
  renderListStats();
  closeTabs();
  showScreen('screen-mode');

  document.getElementById('tile-stats').classList.remove('hidden');
}

function renderListStats() {
  const container = document.getElementById('list-progress-summary');
  container.innerHTML = '';

  const stats = document.createElement('div');
  stats.className = 'progress-stats';

  const makestat = (num, label) => {
    const s = document.createElement('div');
    s.className   = 'stat';
    s.innerHTML   = `<span class="stat-num">${num}</span><span class="stat-label">${label}</span>`;
    return s;
  };

  if (state.currentList.type === 'quiz') {
    const { id, questions } = state.currentList;
    let seen = 0, mastered = 0, totalCorrect = 0, totalAttempts = 0;
    for (const q of questions) {
      const rec = state.progress[id]?.[q.id];
      if (rec) {
        const t = rec.correct + rec.incorrect;
        if (t > 0) {
          seen++;
          totalCorrect  += rec.correct;
          totalAttempts += t;
          if (rec.correct / t >= 0.8) mastered++;
        }
      }
    }
    const pct = totalAttempts > 0 ? Math.round((totalCorrect / totalAttempts) * 100) : 0;
    stats.appendChild(makestat(questions.length, 'questions'));
    stats.appendChild(makestat(seen,             'attempted'));
    stats.appendChild(makestat(mastered,         '≥80% accuracy'));
    stats.appendChild(makestat(totalAttempts > 0 ? `${pct}%` : '—', 'overall accuracy'));
    container.appendChild(stats);
    return;
  }

  if (state.currentList.type === 'translate') {
    stats.appendChild(makestat(state.currentList.sentences?.length ?? 0, 'sentences'));
    container.appendChild(stats);
    return;
  }

  if (state.currentList.type === 'flashcard') {
    stats.appendChild(makestat(state.currentList.cards?.length ?? 0, 'cards'));
    container.appendChild(stats);
    return;
  }
}

// ─────────────────────────────────────────────
// Navigation (skip / back / nav bar)
// ─────────────────────────────────────────────
function skipCard() {
  if (state.currentMode === 'mc-quiz')   { skipMcqCard();       return; }
  if (state.currentMode === 'translate') { skipTranslateCard(); return; }
  if (state.currentMode === 'flashcard') { skipFlashcardCard(); return; }
}

function goBack() {
  if (state.currentMode === 'mc-quiz' && state.mcqGradeMode === 'end') {
    if (state.mcqIndex === 0) return;
    if (state.mcqAdvanceTimeout !== null) {
      clearTimeout(state.mcqAdvanceTimeout);
      state.mcqAdvanceTimeout = null;
    }
    state.mcqIndex--;
    updateNavBar();
    renderMcqCard();
  }
}

function updateNavBar() {
  const isMcQuiz = state.currentMode === 'mc-quiz';
  const footer   = document.getElementById('quiz-footer');
  if (footer) footer.classList.remove('hidden');

  const backBtn = document.getElementById('nav-back-btn');
  const skipBtn = document.getElementById('nav-skip-btn');

  if (isMcQuiz && state.mcqGradeMode === 'end') {
    if (backBtn) { backBtn.classList.remove('hidden'); backBtn.disabled = state.mcqIndex === 0; }
    if (skipBtn) { skipBtn.classList.remove('hidden'); skipBtn.disabled = false; }
    return;
  }

  if (isMcQuiz || state.currentMode === 'translate' || state.currentMode === 'flashcard') {
    if (backBtn) backBtn.classList.add('hidden');
    if (skipBtn) { skipBtn.classList.remove('hidden'); skipBtn.disabled = false; }
    return;
  }

  if (backBtn) backBtn.classList.add('hidden');
  if (skipBtn) skipBtn.classList.add('hidden');
}

// ─────────────────────────────────────────────
// MC Quiz — progress tracking
// ─────────────────────────────────────────────
function getQuizRecord(listId, questionId) {
  if (!state.progress[listId])             state.progress[listId] = {};
  if (!state.progress[listId][questionId]) state.progress[listId][questionId] = { correct: 0, incorrect: 0 };
  return state.progress[listId][questionId];
}

function recordQuizAnswer(listId, questionId, correct) {
  const rec = getQuizRecord(listId, questionId);
  if (correct) rec.correct++;
  else         rec.incorrect++;
  saveProgress();
}

function undoRecordQuizAnswer(listId, questionId, correct) {
  const rec = getQuizRecord(listId, questionId);
  if (correct) rec.correct   = Math.max(0, rec.correct - 1);
  else         rec.incorrect = Math.max(0, rec.incorrect - 1);
  saveProgress();
}

function getMcqWeight(listId, questionId) {
  const rec   = getQuizRecord(listId, questionId);
  const total = rec.correct + rec.incorrect;
  if (total === 0) return 4;
  const accuracy = rec.correct / total;
  if (accuracy < 0.5) return 4;
  if (accuracy < 0.8) return 2;
  return 1;
}

// ─────────────────────────────────────────────
// MC Quiz — session builder
//
// direction: 'es_en' | 'en_es' | null (null = all questions)
// Uses explicit q.direction field; no heuristic inference.
// ─────────────────────────────────────────────
function buildMcqSession(list, direction) {
  let questions = list.questions;

  if (direction) {
    questions = questions.filter(q => q.direction === direction);
  }

  const pool = [];
  for (const q of questions) {
    const w = getMcqWeight(list.id, q.id);
    for (let i = 0; i < w; i++) pool.push(q);
  }

  const shuffled = shuffle(pool);
  const seen     = new Set();
  const session  = [];
  for (const q of shuffled) {
    if (seen.has(q.id)) continue;
    seen.add(q.id);
    session.push(q);
    if (session.length >= SESSION_SIZE) break;
  }
  return session;
}

// ─────────────────────────────────────────────
// MC Quiz — start / render / answer
// ─────────────────────────────────────────────
function startMcQuiz(direction) {
  const list = state.currentList;
  if (!list || list.type !== 'quiz') return;

  state.mcqDirection = direction || null;
  state.mcqSession   = buildMcqSession(list, direction);
  state.mcqIndex     = 0;
  state.mcqResults   = {};
  state.mcqChoices   = {};
  state.mcqGradeMode = state.settings.examMode ? 'end' : 'inline';
  state.currentMode  = 'mc-quiz';

  document.getElementById('progress-bar').style.width   = '0%';
  document.getElementById('progress-count').textContent = `0/${state.mcqSession.length}`;

  updateNavBar();
  showScreen('screen-quiz');
  renderMcqCard();
}

function renderMcqCard() {
  clearConceptSummary();

  const session = state.mcqSession;

  document.getElementById('progress-bar').style.width   = `${(state.mcqIndex / session.length) * 100}%`;
  document.getElementById('progress-count').textContent = `${state.mcqIndex}/${session.length}`;

  if (state.mcqIndex >= session.length) {
    showMcqResults();
    return;
  }

  const q = session[state.mcqIndex];
  showQuizMode('mc-quiz');

  const diagramImg = document.getElementById('mcq-diagram-img');
  if (q.img) {
    diagramImg.src = q.img + '?v=' + APP_VERSION;
    diagramImg.classList.remove('hidden');
  } else {
    diagramImg.src = '';
    diagramImg.classList.add('hidden');
  }

  document.getElementById('mcq-question').textContent = q.q;
  document.getElementById('mcq-feedback').classList.add('hidden');
  document.getElementById('mcq-next').classList.add('hidden');

  const tipBtn = document.getElementById('mcq-tip-btn');
  const tipDiv = document.getElementById('mcq-tip');
  tipDiv.textContent = '';
  tipDiv.classList.add('hidden');
  if (q.tip) {
    tipBtn.classList.remove('hidden');
  } else {
    tipBtn.classList.add('hidden');
  }

  if (!state.mcqChoices[q.id]) {
    state.mcqChoices[q.id] = shuffle([
      { text: q.correct,       isCorrect: true,  wrongIdx: -1 },
      { text: q.incorrect[0],  isCorrect: false, wrongIdx: 0  },
      { text: q.incorrect[1],  isCorrect: false, wrongIdx: 1  },
      { text: q.incorrect[2],  isCorrect: false, wrongIdx: 2  },
    ]);
  }
  const choices = state.mcqChoices[q.id];

  const container = document.getElementById('mcq-choices');
  container.innerHTML = '';

  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }

  const prevResult = state.mcqResults[q.id];

  choices.forEach(choice => {
    const btn = document.createElement('button');
    btn.className   = 'mcq-choice-btn';
    btn.textContent = choice.text;
    if (prevResult && choice.text === prevResult.chosen) {
      btn.classList.add('mcq-choice-selected');
    }
    btn.addEventListener('click', () => selectMcqAnswer(btn, choice, choices));
    container.appendChild(btn);
  });
}

function selectMcqAnswer(btn, choice, allChoices) {
  if (!document.getElementById('mcq-next').classList.contains('hidden')) return;

  const q         = state.mcqSession[state.mcqIndex];
  const isCorrect = choice.isCorrect;

  document.querySelectorAll('.mcq-choice-btn').forEach(b => { b.disabled = true; });
  document.getElementById('mcq-tip-btn').classList.add('hidden');

  const prev = state.mcqResults[q.id];
  if (prev) undoRecordQuizAnswer(state.currentList.id, q.id, prev.correct);

  recordQuizAnswer(state.currentList.id, q.id, isCorrect);
  state.mcqResults[q.id] = {
    question: q,
    chosen:   choice.text,
    correct:  isCorrect,
    whyWrong: choice.wrongIdx >= 0 && q.why_wrong ? q.why_wrong[choice.wrongIdx] : null,
  };

  if (state.mcqGradeMode === 'end') {
    btn.classList.add('mcq-choice-selected');
    updateNavBar();
    state.mcqAdvanceTimeout = setTimeout(() => {
      state.mcqAdvanceTimeout = null;
      advanceMcqCard();
    }, 400);
  } else {
    document.querySelectorAll('.mcq-choice-btn').forEach((b, i) => {
      if (allChoices[i].isCorrect) b.classList.add('choice-correct');
    });
    if (!isCorrect) btn.classList.add('choice-wrong');

    const badge       = document.getElementById('mcq-feedback-badge');
    const explanation = document.getElementById('mcq-explanation');

    if (isCorrect) {
      badge.textContent = 'Correct!';
      badge.className   = 'mcq-feedback-badge mcq-badge--correct';
      explanation.textContent = q.why_correct;
      if (state.settings.autoAdvanceDelay > 0) {
        state.mcqAdvanceTimeout = setTimeout(() => {
          state.mcqAdvanceTimeout = null;
          advanceMcqCard();
        }, state.settings.autoAdvanceDelay);
      }
    } else {
      badge.textContent = 'Incorrect';
      badge.className   = 'mcq-feedback-badge mcq-badge--wrong';
      const whyWrong    = choice.wrongIdx >= 0 && q.why_wrong ? q.why_wrong[choice.wrongIdx] : '';
      explanation.innerHTML = `<strong>Why that's wrong:</strong> ${whyWrong}<br><br><strong>Correct answer:</strong> ${q.correct}<br>${q.why_correct}`;
      showConceptSummary(q.concepts);
    }

    document.getElementById('mcq-feedback').classList.remove('hidden');
    document.getElementById('mcq-next').classList.remove('hidden');
  }
}

function advanceMcqCard() {
  state.mcqIndex++;
  updateNavBar();
  renderMcqCard();
}

function skipMcqCard() {
  if (!document.getElementById('mcq-next').classList.contains('hidden')) return;
  state.mcqSession.splice(state.mcqIndex, 1);
  updateNavBar();
  renderMcqCard();
}

function showMcqResults() {
  const results  = state.mcqSession.map(q => state.mcqResults[q.id]).filter(Boolean);
  results.sort((a, b) => (a.correct === b.correct ? 0 : a.correct ? 1 : -1));
  const numRight = results.filter(r => r.correct).length;
  const total    = results.length;
  const pct      = total > 0 ? Math.round((numRight / total) * 100) : 0;
  const grade    = pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 60 ? 'D' : 'F';

  document.getElementById('results-title').textContent = 'Quiz Results';
  document.getElementById('results-summary').innerHTML = `
    <div class="results-score">
      <span class="score-big">${numRight}/${total}</span>
      <span class="score-pct score-grade-${grade.toLowerCase()}">${pct}% &nbsp; ${grade}</span>
    </div>
  `;

  const details = document.getElementById('results-details');
  details.innerHTML = '';

  const heading = document.createElement('h3');
  heading.textContent = 'Review:';
  details.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'mcq-missed-list';

  for (const r of results) {
    const item = document.createElement('div');
    item.className = r.correct ? 'mcq-missed-item mcq-item--correct' : 'mcq-missed-item';

    if (r.correct) {
      item.innerHTML = `
        <div class="mcq-missed-q">${r.question.q}</div>
        <div class="mcq-missed-correct"><span class="mcq-correct-text">${r.question.correct}</span></div>
        <div class="mcq-missed-why-correct">${r.question.why_correct}</div>
      `;
    } else {
      item.innerHTML = `
        <div class="mcq-missed-q">${r.question.q}</div>
        <div class="mcq-missed-chosen">You answered: <span class="mcq-chosen-text">${r.chosen}</span></div>
        <div class="mcq-missed-why-wrong">${r.whyWrong || ''}</div>
        <div class="mcq-missed-correct">Correct answer: <span class="mcq-correct-text">${r.question.correct}</span></div>
        <div class="mcq-missed-why-correct">${r.question.why_correct}</div>
      `;
    }
    list.appendChild(item);
  }

  details.appendChild(list);
  showScreen('screen-results');
}

// ─────────────────────────────────────────────
// Concept summaries (inline after wrong answer)
// ─────────────────────────────────────────────
function buildSummaryTable(def) {
  const table = document.createElement('table');
  table.className = 'summary-table';

  if (def.headers) {
    const thead = document.createElement('thead');
    const tr    = document.createElement('tr');
    for (const h of def.headers) {
      const th = document.createElement('th');
      th.textContent = h;
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
  }

  const tbody = document.createElement('tbody');
  for (const row of (def.rows || [])) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function buildSummaryList(def) {
  const ul = document.createElement('ul');
  ul.className = 'summary-list';
  for (const item of (def.items || [])) {
    const li = document.createElement('li');
    li.textContent = item;
    ul.appendChild(li);
  }
  return ul;
}

function showConceptSummary(concepts) {
  const container = document.getElementById('mcq-concept-summary');
  if (!container || !concepts || !concepts.length) return;

  const summaries = state.currentList?.summaries || {};
  const relevant  = concepts.filter(c => summaries[c]);
  if (!relevant.length) { container.innerHTML = ''; return; }

  container.innerHTML = '';

  for (const slug of relevant) {
    const def = summaries[slug];

    const section = document.createElement('div');
    section.className = 'concept-summary-section';

    const title = document.createElement('div');
    title.className   = 'concept-summary-title';
    title.textContent = def.title;
    section.appendChild(title);

    if (def.type === 'table')     section.appendChild(buildSummaryTable(def));
    else if (def.type === 'list') section.appendChild(buildSummaryList(def));

    container.appendChild(section);
  }
}

function clearConceptSummary() {
  const container = document.getElementById('mcq-concept-summary');
  if (container) container.innerHTML = '';
}

function showMcqTip() {
  const q = state.mcqSession[state.mcqIndex];
  if (!q || !q.tip) return;
  document.getElementById('mcq-tip-btn').classList.add('hidden');
  const tipDiv = document.getElementById('mcq-tip');
  tipDiv.textContent = q.tip;
  tipDiv.classList.remove('hidden');
}

// ─────────────────────────────────────────────
// Reference panel (all summaries for current unit)
// ─────────────────────────────────────────────
function showReferencePanel() {
  renderReferencePanelContent();
  document.getElementById('reference-panel').classList.remove('hidden');
}

function hideReferencePanel() {
  document.getElementById('reference-panel').classList.add('hidden');
}

function renderReferencePanelContent() {
  const summaries = state.currentList?.summaries || {};
  const container = document.getElementById('reference-panel-content');
  container.innerHTML = '';

  for (const def of Object.values(summaries)) {
    const section = document.createElement('div');
    section.className = 'ref-summary-section';

    const title = document.createElement('h3');
    title.className   = 'ref-summary-title';
    title.textContent = def.title;
    section.appendChild(title);

    if (def.type === 'table')     section.appendChild(buildSummaryTable(def));
    else if (def.type === 'list') section.appendChild(buildSummaryList(def));

    container.appendChild(section);
  }
}

// ─────────────────────────────────────────────
// All Terms screen
// ─────────────────────────────────────────────
function showAllTerms() {
  renderAllTerms();
  showScreen('screen-terms');
}

function renderAllTerms() {
  const list  = state.currentList;
  const terms = list.terms || [];

  document.getElementById('terms-title').textContent = list.name;

  const tbody = document.getElementById('all-terms-body');
  tbody.innerHTML = '';

  for (const t of terms) {
    const row   = document.createElement('tr');
    const tdTerm = document.createElement('td');
    const tdDef  = document.createElement('td');
    tdTerm.textContent = t.term;
    tdTerm.className   = 'terms-term';
    tdDef.textContent  = t.definition;
    tdDef.className    = 'terms-def';
    row.appendChild(tdTerm);
    row.appendChild(tdDef);
    tbody.appendChild(row);
  }
}

// ─────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────
let currentStatsSort = 'missed';

function startStats() {
  currentStatsSort = 'missed';
  switchTab('stats');
}

function sortStats(by) {
  currentStatsSort = by;
  renderStats();
}

function renderStats() {
  if (state.currentList.type === 'quiz') {
    renderQuizStats(state.currentList.id);
    return;
  }
}

function renderQuizStats(listId) {
  const questions = state.currentList.questions;

  const rows = questions.map(q => {
    const rec       = state.progress[listId]?.[q.id] ?? { correct: 0, incorrect: 0 };
    const correct   = rec.correct;
    const incorrect = rec.incorrect;
    const total     = correct + incorrect;
    const accuracy  = total > 0 ? Math.round((correct / total) * 100) : null;
    return { q, correct, incorrect, total, accuracy };
  });

  if (currentStatsSort === 'missed') {
    rows.sort((a, b) => {
      if (a.total === 0 && b.total === 0) return 0;
      if (a.total === 0) return 1;
      if (b.total === 0) return -1;
      return b.incorrect - a.incorrect || a.q.q.localeCompare(b.q.q);
    });
  } else if (currentStatsSort === 'correct') {
    rows.sort((a, b) => {
      if (a.total === 0 && b.total === 0) return 0;
      if (a.total === 0) return 1;
      if (b.total === 0) return -1;
      return b.correct - a.correct || a.q.q.localeCompare(b.q.q);
    });
  } else {
    rows.sort((a, b) => a.q.q.localeCompare(b.q.q));
  }

  const statFront = document.getElementById('stats-col-front');
  const statBack  = document.getElementById('stats-col-back');
  if (statFront) statFront.textContent = 'Question';
  if (statBack)  statBack.textContent  = 'Correct Answer';

  const tbody = document.getElementById('stats-table-body');
  tbody.innerHTML = '';

  for (const r of rows) {
    const row = document.createElement('tr');
    if (r.total === 0) row.classList.add('stats-unseen');

    const accText  = r.accuracy !== null ? r.accuracy + '%' : '—';
    const accClass = r.accuracy === null ? '' :
                     r.accuracy >= 80   ? 'acc-good' :
                     r.accuracy >= 50   ? 'acc-ok'   : 'acc-bad';

    const addCell = (text, cls) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      row.appendChild(td);
    };

    addCell(r.q.q,                            'stats-es');
    addCell(r.q.correct);
    addCell(r.correct   > 0 ? r.correct   : '—', 'stats-num');
    addCell(r.incorrect > 0 ? r.incorrect : '—', 'stats-num');
    addCell(accText, `stats-acc ${accClass}`);

    tbody.appendChild(row);
  }

  document.querySelectorAll('.sort-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById('sort-' + currentStatsSort).classList.add('active');
}

// ─────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────
function restartSession() {
  if (state.currentMode === 'mc-quiz') {
    startMcQuiz(state.mcqDirection);
  } else if (state.currentMode === 'translate') {
    startTranslate(state.translateDirection);
  } else if (state.currentMode === 'flashcard') {
    startFlashcards();
  }
}

// ─────────────────────────────────────────────
// Sentence Translation mode
// ─────────────────────────────────────────────
function startTranslate(direction) {
  const list = state.currentList;
  if (!list || list.type !== 'translate') return;

  state.translateDirection = direction;
  const sentences = list.sentences;

  let expanded;
  if (direction === 'es_en') {
    expanded = sentences.map(s => ({ sentence: s, direction: 'es_en' }));
  } else if (direction === 'en_es') {
    expanded = sentences.map(s => ({ sentence: s, direction: 'en_es' }));
  } else {
    expanded = sentences.flatMap(s => [
      { sentence: s, direction: 'es_en' },
      { sentence: s, direction: 'en_es' },
    ]);
  }

  state.translateSession  = shuffle(expanded).slice(0, SESSION_SIZE);
  state.translateIndex    = 0;
  state.translateResults  = [];
  state.currentMode       = 'translate';

  document.getElementById('progress-bar').style.width   = '0%';
  document.getElementById('progress-count').textContent = `0/${state.translateSession.length}`;

  updateNavBar();
  showScreen('screen-quiz');
  renderTranslateCard();
}

function renderTranslateCard() {
  const session = state.translateSession;

  document.getElementById('progress-bar').style.width   = `${(state.translateIndex / session.length) * 100}%`;
  document.getElementById('progress-count').textContent = `${state.translateIndex}/${session.length}`;

  if (state.translateIndex >= session.length) {
    showTranslateResults();
    return;
  }

  const { sentence, direction } = session[state.translateIndex];
  showQuizMode('translate');

  document.getElementById('translate-direction').textContent = direction === 'es_en' ? 'Spanish → English' : 'English → Spanish';
  document.getElementById('translate-sentence').textContent  = direction === 'es_en' ? sentence.es : sentence.en;

  const input    = document.getElementById('translate-input');
  const checkBtn = document.getElementById('translate-check');
  const feedback = document.getElementById('translate-feedback');

  input.value    = '';
  input.disabled = false;
  checkBtn.classList.remove('hidden');
  checkBtn.disabled = false;
  feedback.classList.add('hidden');
  document.getElementById('translate-missed').classList.remove('hidden');
  document.getElementById('translate-got-it').classList.remove('hidden');

  input.focus();
}

function checkTranslateAnswer() {
  const { sentence, direction } = state.translateSession[state.translateIndex];
  const correct = direction === 'es_en' ? sentence.en : sentence.es;
  const userAnswer = document.getElementById('translate-input').value.trim();

  document.getElementById('translate-input').disabled     = true;
  document.getElementById('translate-check').disabled     = true;
  document.getElementById('translate-correct-text').textContent = correct;
  document.getElementById('translate-feedback').classList.remove('hidden');

  if (normalize(userAnswer) === normalize(correct)) {
    document.getElementById('translate-missed').classList.add('hidden');
    document.getElementById('translate-got-it').classList.add('hidden');
    setTimeout(() => translateSelfGrade(true), 1000);
  }
}

function skipTranslateCard() {
  if (!document.getElementById('translate-feedback').classList.contains('hidden')) return;
  state.translateSession.splice(state.translateIndex, 1);
  renderTranslateCard();
}

function translateSelfGrade(isCorrect) {
  const { sentence, direction } = state.translateSession[state.translateIndex];
  const userAnswer = document.getElementById('translate-input').value.trim();
  state.translateResults.push({ sentence, direction, userAnswer, correct: isCorrect });
  state.translateIndex++;
  renderTranslateCard();
}

function showTranslateResults() {
  const results  = state.translateResults;
  const numRight = results.filter(r => r.correct).length;
  const total    = results.length;
  const pct      = total > 0 ? Math.round((numRight / total) * 100) : 0;
  const grade    = pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 60 ? 'D' : 'F';

  document.getElementById('results-title').textContent = 'Translation Results';
  document.getElementById('results-summary').innerHTML = `
    <div class="results-score">
      <span class="score-big">${numRight}/${total}</span>
      <span class="score-pct score-grade-${grade.toLowerCase()}">${pct}% &nbsp; ${grade}</span>
    </div>
  `;

  const details = document.getElementById('results-details');
  details.innerHTML = '';

  const missed = results.filter(r => !r.correct);

  if (missed.length === 0) {
    const p = document.createElement('p');
    p.className   = 'all-correct';
    p.textContent = 'Perfect session!';
    details.appendChild(p);
  } else {
    const h = document.createElement('h3');
    h.textContent = 'Review these sentences:';
    details.appendChild(h);

    const list = document.createElement('div');
    list.className = 'translate-missed-list';

    for (const r of missed) {
      const prompt  = r.direction === 'es_en' ? r.sentence.es : r.sentence.en;
      const correct = r.direction === 'es_en' ? r.sentence.en : r.sentence.es;

      const item = document.createElement('div');
      item.className = 'translate-missed-item';
      item.innerHTML = `
        <div class="translate-missed-prompt">${prompt}</div>
        ${r.userAnswer ? `<div class="translate-missed-yours">Your answer: <span class="translate-yours-text">${r.userAnswer}</span></div>` : ''}
        <div class="translate-missed-correct">Correct: <span class="translate-correct-ans">${correct}</span></div>
      `;
      list.appendChild(item);
    }
    details.appendChild(list);

    const conceptCounts = {};
    for (const r of missed) {
      for (const c of (r.sentence.concepts || [])) {
        conceptCounts[c] = (conceptCounts[c] || 0) + 1;
      }
    }
    const sorted = Object.entries(conceptCounts).sort((a, b) => b[1] - a[1]);

    if (sorted.length > 0) {
      const h2 = document.createElement('h3');
      h2.textContent = 'Concepts to review:';
      details.appendChild(h2);

      const breakdown = document.createElement('div');
      breakdown.className = 'concept-breakdown';
      for (const [concept, count] of sorted) {
        const tag = document.createElement('div');
        tag.className = 'concept-tag';
        tag.innerHTML = `<span class="concept-name">${concept}</span><span class="concept-count">${count} missed</span>`;
        breakdown.appendChild(tag);
      }
      details.appendChild(breakdown);
    }
  }

  showScreen('screen-results');
}

// ─────────────────────────────────────────────
// Flashcard mode
//
// Generic base study mode: tap a card to reveal its back, then
// self-assess with Got it / Missed it. Card front is either an
// image (card.image, e.g. a road sign with no text) or plain
// text (card.front). Card back (card.back) is always text.
// ─────────────────────────────────────────────
function startFlashcards() {
  const list = state.currentList;
  if (!list || list.type !== 'flashcard') return;

  state.flashcardSession  = shuffle(list.cards).slice(0, SESSION_SIZE);
  state.flashcardIndex    = 0;
  state.flashcardResults  = [];
  state.flashcardFlipped  = false;
  state.currentMode       = 'flashcard';

  document.getElementById('progress-bar').style.width   = '0%';
  document.getElementById('progress-count').textContent = `0/${state.flashcardSession.length}`;

  updateNavBar();
  showScreen('screen-quiz');
  renderFlashcardCard();
}

function renderFlashcardCard() {
  const session = state.flashcardSession;

  document.getElementById('progress-bar').style.width   = `${(state.flashcardIndex / session.length) * 100}%`;
  document.getElementById('progress-count').textContent = `${state.flashcardIndex}/${session.length}`;

  if (state.flashcardIndex >= session.length) {
    showFlashcardResults();
    return;
  }

  const card = session[state.flashcardIndex];
  showQuizMode('flashcard');
  state.flashcardFlipped = false;

  const img      = document.getElementById('fc-image');
  const frontTxt = document.getElementById('fc-front-text');
  if (card.image) {
    img.src = card.image + '?v=' + APP_VERSION;
    img.alt = '';
    img.classList.remove('hidden');
    frontTxt.classList.add('hidden');
    frontTxt.textContent = '';
  } else {
    img.src = '';
    img.classList.add('hidden');
    frontTxt.classList.remove('hidden');
    frontTxt.textContent = card.front || '';
  }

  document.getElementById('fc-back-text').textContent = card.back;
  document.getElementById('fc-definition').classList.add('hidden');
  document.getElementById('fc-hint').classList.remove('hidden');
  document.getElementById('fc-answer-btns').classList.add('hidden');
}

function flipFlashcard() {
  if (state.flashcardFlipped) return;
  state.flashcardFlipped = true;
  document.getElementById('fc-definition').classList.remove('hidden');
  document.getElementById('fc-answer-btns').classList.remove('hidden');
  document.getElementById('fc-hint').classList.add('hidden');
}

function gradeFlashcard(correct) {
  if (!state.flashcardFlipped) return;
  const card = state.flashcardSession[state.flashcardIndex];
  state.flashcardResults.push({ card, correct });
  state.flashcardIndex++;
  renderFlashcardCard();
}

function skipFlashcardCard() {
  if (state.flashcardFlipped) return;
  state.flashcardSession.splice(state.flashcardIndex, 1);
  renderFlashcardCard();
}

function showFlashcardResults() {
  const results  = state.flashcardResults;
  const numRight = results.filter(r => r.correct).length;
  const total    = results.length;
  const pct      = total > 0 ? Math.round((numRight / total) * 100) : 0;
  const grade    = pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 60 ? 'D' : 'F';

  document.getElementById('results-title').textContent = 'Flashcard Results';
  document.getElementById('results-summary').innerHTML = `
    <div class="results-score">
      <span class="score-big">${numRight}/${total}</span>
      <span class="score-pct score-grade-${grade.toLowerCase()}">${pct}% &nbsp; ${grade}</span>
    </div>
  `;

  const details = document.getElementById('results-details');
  details.innerHTML = '';

  const missed = results.filter(r => !r.correct);

  if (missed.length === 0) {
    const p = document.createElement('p');
    p.className   = 'all-correct';
    p.textContent = 'Perfect session!';
    details.appendChild(p);
  } else {
    const h = document.createElement('h3');
    h.textContent = 'Review these:';
    details.appendChild(h);

    const list = document.createElement('div');
    list.className = 'translate-missed-list';

    for (const r of missed) {
      const item = document.createElement('div');
      item.className = 'translate-missed-item';
      item.innerHTML = `<div class="translate-missed-correct">${r.card.back}</div>`;
      list.appendChild(item);
    }
    details.appendChild(list);
  }

  showScreen('screen-results');
}

// ─────────────────────────────────────────────
// Update check
// ─────────────────────────────────────────────
async function checkForUpdate() {
  try {
    const res  = await fetch(`version.json?_=${Date.now()}`);
    const data = await res.json();
    if (data.version > APP_VERSION) {
      document.getElementById('update-banner').classList.remove('hidden');
    }
  } catch {}
}

setInterval(checkForUpdate, 10 * 60 * 1000);

function reloadApp() {
  window.location.reload();
}

function dismissUpdateBanner() {
  document.getElementById('update-banner').classList.add('hidden');
}

// ─────────────────────────────────────────────
// Install tip (shown once, dismissible)
// ─────────────────────────────────────────────
function showInstallTip() {
  if (localStorage.getItem(INSTALL_TIP_KEY)) return;

  const body = document.querySelector('#screen-home .screen-body');
  if (!body) return;

  const tip = document.createElement('div');
  tip.id        = 'install-tip';
  tip.className = 'install-tip';
  tip.innerHTML = `
    <button class="install-tip-dismiss" id="install-tip-dismiss">&#x2715;</button>
    <p class="install-tip-title">Add to Home Screen</p>
    <p class="install-tip-text">
      <strong>iPhone/iPad:</strong> tap the Share icon (&uarr;) in Safari, then "Add to Home Screen".<br>
      <strong>Android:</strong> tap the Chrome menu (&vellip;), then "Add to Home Screen".
    </p>
  `;
  body.prepend(tip);
  document.getElementById('install-tip-dismiss').addEventListener('click', dismissInstallTip);
}

function dismissInstallTip() {
  localStorage.setItem(INSTALL_TIP_KEY, '1');
  const el = document.getElementById('install-tip');
  if (el) el.remove();
}

// ─────────────────────────────────────────────
// Progress export / import
// ─────────────────────────────────────────────
function exportProgress() {
  const data = JSON.stringify(state.progress, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'study-progress.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importProgress(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (typeof data !== 'object' || Array.isArray(data)) throw new Error();
      state.progress = data;
      saveProgress();
      event.target.value = '';
      alert('Progress imported.');
      if (state.currentList) renderListStats();
    } catch {
      alert('Invalid file. Please use a file exported from this app.');
    }
  };
  reader.readAsText(file);
}

// ─────────────────────────────────────────────
// Reference chart overlay (existing per-list image ref)
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// Event listeners (attached once at init)
// ─────────────────────────────────────────────
function setupEventListeners() {
  // Class + Unit pickers
  document.getElementById('class-picker-btn').addEventListener('click', toggleClassPicker);
  document.getElementById('unit-picker-btn').addEventListener('click', toggleUnitPicker);
  document.addEventListener('click', e => {
    const inClass = document.getElementById('class-picker').contains(e.target);
    const inUnit  = document.getElementById('unit-picker').contains(e.target);
    if (!inClass && !inUnit) closeAllPickers();
  });

  // Exam mode checkbox
  document.getElementById('exam-mode-checkbox').addEventListener('change', e => {
    setExamMode(e.target.checked);
  });

  // Flashcards
  document.getElementById('flashcard-card').addEventListener('click', flipFlashcard);
  document.getElementById('fc-missed').addEventListener('click', () => gradeFlashcard(false));
  document.getElementById('fc-got-it').addEventListener('click', () => gradeFlashcard(true));

  // MCQ
  document.getElementById('mcq-next').addEventListener('click', advanceMcqCard);

  // Translate
  document.getElementById('translate-check').addEventListener('click', checkTranslateAnswer);
  document.getElementById('translate-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') checkTranslateAnswer();
  });
  document.getElementById('translate-got-it').addEventListener('click', () => translateSelfGrade(true));
  document.getElementById('translate-missed').addEventListener('click', () => translateSelfGrade(false));

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const refPanel = document.getElementById('reference-panel');
      if (refPanel && !refPanel.classList.contains('hidden')) { hideReferencePanel(); return; }
      if (state.currentMode) { confirmQuit(); return; }
      const termsScreen = document.getElementById('screen-terms');
      if (termsScreen && termsScreen.classList.contains('active')) { showScreen('screen-mode'); return; }
    }
    const inMcQuiz = state.currentMode === 'mc-quiz';
    if (inMcQuiz && state.mcqGradeMode === 'end') {
      if (e.key === 'ArrowLeft'  && !e.metaKey && !e.altKey) { e.preventDefault(); goBack(); }
      if (e.key === 'ArrowRight' && !e.metaKey && !e.altKey) { e.preventDefault(); skipCard(); }
    }
  });
}

// ─────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);
