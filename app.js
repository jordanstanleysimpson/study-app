'use strict';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const COMFORT_STREAK  = 3;   // correct-in-a-row to unlock the reverse direction
const SESSION_SIZE    = 20;  // max cards per session
const STORAGE_KEY     = 'study-app-progress';
const SETTINGS_KEY    = 'study-app-settings';
const GITHUB_KEY      = 'study-app-github';
const GIST_FILENAME   = 'study-progress.json';
const APP_VERSION     = '2026-03-09T00:01:57Z';
const INSTALL_TIP_KEY = 'study-app-install-dismissed';

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
const state = {
  lists:          [],     // metadata from index.json
  currentList:    null,   // full list object { id, pairs, … }
  currentMode:    null,   // 'flashcard' | 'type' | 'choice' | 'mc-quiz'
  session:        [],     // [{ pair: {es,en}, direction: 'es_en'|'en_es' }, …]
  sessionIndex:   0,
  sessionResults: [],     // [{ pair, direction, correct: bool }, …]
  sessionHistory: [],     // [{ index, pair, direction, recorded, correct }] — for back/skip
  subjectCache:   {},     // { [listId]: listObject } — other units in same subject, loaded in bg
  progress:       {},     // persisted to localStorage
  settings:       { autoAdvanceDelay: 1000 },  // app settings
  currentAnswer:  null,   // correct answer for the active card
  answered:       false,  // has the current card been evaluated?
  flipped:        false,  // flashcard flip state
  // MC Quiz state
  mcqSession:     [],     // [{ question }, …] — 20 selected questions
  mcqIndex:       0,
  mcqResults:     [],     // [{ question, chosen, correct, whyWrong }]
  mcqGradeMode:   'inline', // 'inline' | 'end'
};

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────
function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // strip diacritics for loose matching
    .trim();
}

function listLabels() {
  return state.currentList?.labels ?? { front: 'Spanish', back: 'English' };
}

function updateSubjectLabels() {
  const { front, back } = listLabels();
  const fwd  = `${front} → ${back}`;
  const rev  = `${back} → ${front}`;

  const isDiagram = state.currentList.type === 'diagram';
  const isMcQuiz  = state.currentList.type === 'quiz';

  document.getElementById('btn-flashcard').classList.toggle('hidden', isMcQuiz);
  document.getElementById('btn-type-it').classList.toggle('hidden', !!state.currentList.labels || isMcQuiz);
  document.getElementById('btn-choice-fwd').classList.toggle('hidden', isDiagram || isMcQuiz);
  document.getElementById('btn-choice-rev').classList.toggle('hidden', isDiagram || isMcQuiz);
  document.getElementById('btn-match').classList.toggle('hidden', isDiagram || isMcQuiz);
  document.getElementById('btn-mc-quiz-inline').classList.toggle('hidden', !isMcQuiz);
  document.getElementById('btn-mc-quiz-end').classList.toggle('hidden', !isMcQuiz);
  document.getElementById('mode-grid').classList.toggle('mode-grid--one', isDiagram);
  document.getElementById('mode-grid').classList.toggle('mode-grid--two', isMcQuiz);
  document.getElementById('mode-grid').classList.toggle('mode-grid--three', !isDiagram && !isMcQuiz && !!state.currentList.labels);

  const isSubject = !!state.currentList.labels;
  document.getElementById('mode-icon-fwd').textContent = isSubject ? '📋' : '🇪🇸';
  document.getElementById('mode-icon-rev').textContent = isSubject ? '🔄' : '🇬🇧';

  const modeDescType  = document.getElementById('mode-desc-type');
  const modeDescFwd   = document.getElementById('mode-desc-fwd');
  const modeDescRev   = document.getElementById('mode-desc-rev');
  const modeDescMatch = document.getElementById('mode-desc-match');
  if (modeDescType)  modeDescType.textContent  = state.currentList.labels ? `See definition, type the term` : 'Spell the answer';
  if (modeDescFwd)   modeDescFwd.textContent   = fwd;
  if (modeDescRev)   modeDescRev.textContent   = rev;
  if (modeDescMatch) modeDescMatch.textContent = `Connect ${front} to ${back}`;

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
  // Fire-and-forget — never blocks the UI
  idbOpen()
    .then(db => db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(data, 'main'))
    .catch(() => {});
}

function idbLoad() {
  return new Promise(resolve => {
    idbOpen()
      .then(db => {
        const req      = db.transaction(IDB_STORE).objectStore(IDB_STORE).get('main');
        req.onsuccess  = e => resolve(e.target.result ?? null);
        req.onerror    = ()  => resolve(null);
      })
      .catch(() => resolve(null));
  });
}

async function loadProgress() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      state.progress = JSON.parse(stored);
      return;
    }
  } catch {}

  // localStorage empty — try IndexedDB
  try {
    const backup = await idbLoad();
    if (backup && typeof backup === 'object') {
      state.progress = backup;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(backup));
      return;
    }
  } catch {}

  // IndexedDB also empty — try GitHub Gist
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

  // Verify token by hitting the user endpoint
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error('Invalid token');
    const user = await res.json();
    saveGithubSettings({ token, gistId: null, user: user.login });
    document.getElementById('github-token-input').value = '';
    closeGithubPanel();
    await gistSync(); // create the gist immediately
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

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    state.settings = { autoAdvanceDelay: 1000, matchSize: 20, ...saved };
  } catch {
    state.settings = { autoAdvanceDelay: 1000, matchSize: 20 };
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function getWordRecord(listId, word) {
  if (!state.progress[listId])       state.progress[listId] = {};
  if (!state.progress[listId][word]) {
    state.progress[listId][word] = {
      es_en: { correct: 0, incorrect: 0, streak: 0, comfortable: false },
      en_es: { correct: 0, incorrect: 0, streak: 0, comfortable: false },
    };
  }
  return state.progress[listId][word];
}

function recordAnswer(listId, word, direction, correct) {
  const dir = getWordRecord(listId, word)[direction];
  if (correct) {
    dir.correct++;
    dir.streak++;
    if (dir.streak >= COMFORT_STREAK) dir.comfortable = true;
  } else {
    dir.incorrect++;
    dir.streak = 0;
  }
  saveProgress();
}

function undoRecordAnswer(listId, word, direction, correct) {
  const dir = getWordRecord(listId, word)[direction];
  if (correct) {
    dir.correct   = Math.max(0, dir.correct - 1);
    dir.streak    = Math.max(0, dir.streak - 1);
  } else {
    dir.incorrect = Math.max(0, dir.incorrect - 1);
  }
  saveProgress();
}

function skipCard() {
  if (state.currentMode === 'mc-quiz') { skipMcqCard(); return; }
  if (state.answered) return;
  const { pair, direction } = state.session[state.sessionIndex];
  state.sessionHistory.push({ index: state.sessionIndex, pair, direction, recorded: false, correct: null });
  state.sessionIndex++;
  renderCard();
}

function goBack() {
  if (state.sessionHistory.length === 0) return;
  const last = state.sessionHistory.pop();
  if (last.recorded) {
    undoRecordAnswer(state.currentList.id, last.pair.es, last.direction, last.correct);
    state.sessionResults.pop();
  }
  state.sessionIndex = last.index;
  state.answered = false;
  renderCard();
}

function updateNavBar() {
  const isMatch  = state.currentMode === 'match';
  const isMcQuiz = state.currentMode === 'mc-quiz';
  const footer   = document.getElementById('quiz-footer');
  if (footer) footer.classList.toggle('hidden', isMatch);

  // For mc-quiz, show only the skip button; hide back
  const backBtn = document.getElementById('nav-back-btn');
  const skipBtn = document.getElementById('nav-skip-btn');
  if (isMcQuiz) {
    if (backBtn) backBtn.classList.add('hidden');
    if (skipBtn) { skipBtn.classList.remove('hidden'); skipBtn.disabled = false; }
    return;
  }
  if (backBtn) backBtn.classList.remove('hidden');
  if (skipBtn) skipBtn.classList.remove('hidden');
  if (backBtn) backBtn.disabled = state.sessionHistory.length === 0;
  if (skipBtn) skipBtn.disabled = state.answered;
}

function isEsEnComfortable(listId, word) {
  return getWordRecord(listId, word).es_en.comfortable;
}

// ─────────────────────────────────────────────
// Session builder — weighted card pool
//
// es→en: always included; weight = 4 (new), 3 (seen but not comfortable), 1 (comfortable)
// en→es: only added once the word's es→en direction is comfortable
// ─────────────────────────────────────────────
function getWeight(listId, word, direction) {
  const dir = getWordRecord(listId, word)[direction];
  const total = dir.correct + dir.incorrect;
  if (total === 0)        return 4;
  if (!dir.comfortable)  return 3;
  return 1;
}

function buildSession(list) {
  const pool = [];

  for (const pair of list.pairs) {
    const w = getWeight(list.id, pair.es, 'es_en');
    for (let i = 0; i < w; i++) pool.push({ pair, direction: 'es_en' });

    if (isEsEnComfortable(list.id, pair.es)) {
      const w2 = getWeight(list.id, pair.es, 'en_es');
      for (let i = 0; i < w2; i++) pool.push({ pair, direction: 'en_es' });
    }
  }

  // Shuffle then trim, avoiding back-to-back repetition of the same word
  const shuffled = shuffle(pool);
  const session  = [];
  let lastWord   = null;

  for (const card of shuffled) {
    if (session.length >= SESSION_SIZE) break;
    if (card.pair.es === lastWord) continue;
    session.push(card);
    lastWord = card.pair.es;
  }

  return session;
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
  const browseTab  = document.getElementById('tab-browse');
  const statsTab   = document.getElementById('tab-stats');
  const browseTile = document.getElementById('tile-browse');
  const statsTile  = document.getElementById('tile-stats');

  if (name === 'browse') {
    const opening = browseTab.classList.contains('hidden');
    browseTab.classList.toggle('hidden', !opening);
    statsTab.classList.add('hidden');
    browseTile.classList.toggle('active', opening);
    statsTile.classList.remove('active');
    if (opening) renderBrowse();
  } else if (name === 'stats') {
    const opening = statsTab.classList.contains('hidden');
    statsTab.classList.toggle('hidden', !opening);
    browseTab.classList.add('hidden');
    statsTile.classList.toggle('active', opening);
    browseTile.classList.remove('active');
    if (opening) renderStats();
  }
}

function closeTabs() {
  document.getElementById('tab-browse').classList.add('hidden');
  document.getElementById('tab-stats').classList.add('hidden');
  document.getElementById('tile-browse').classList.remove('active');
  document.getElementById('tile-stats').classList.remove('active');
}

function setAutoAdvanceDelay(value) {
  state.settings.autoAdvanceDelay = parseInt(value, 10);
  saveSettings();
  updateAutoAdvanceUI();
}

function setMatchSize(value) {
  state.settings.matchSize = parseInt(value, 10);
  saveSettings();
  updateMatchSizeUI();
}

function updateMatchSizeUI() {
  const select = document.getElementById('match-size-select');
  if (select) select.value = state.settings.matchSize.toString();
}

function updateAutoAdvanceUI() {
  const value = state.settings.autoAdvanceDelay.toString();
  const select1 = document.getElementById('auto-advance-select');
  const select2 = document.getElementById('quiz-auto-advance-select');
  if (select1) select1.value = value;
  if (select2) select2.value = value;
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
  updateMatchSizeUI();
  checkForUpdate();

  try {
    const res  = await fetch('data/index.json');
    const data = await res.json();
    state.lists = data.lists.sort((a, b) => b.created.localeCompare(a.created));
    buildClassPicker();

    // Auto-select first class and first list
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
  const comfortable = Object.values(state.progress[listId])
    .filter(w => w.es_en.comfortable).length;
  return Math.round((comfortable / wordCount) * 100);
}

// ─────────────────────────────────────────────
// Class + Unit pickers
// ─────────────────────────────────────────────
let selectedClass = null;

function buildClassPicker() {
  const classes = [...new Set(state.lists.map(l => l.subject))];
  const dropdown = document.getElementById('class-picker-dropdown');
  dropdown.innerHTML = '';

  for (const cls of classes) {
    const btn = document.createElement('button');
    btn.className       = 'list-picker-option';
    btn.textContent     = cls;
    btn.dataset.subject = cls;
    btn.addEventListener('click', () => {
      closeAllPickers();
      switchClass(cls);
    });
    dropdown.appendChild(btn);
  }
}

function buildUnitPicker(subject) {
  const lists    = state.lists.filter(l => l.subject === subject).slice().reverse();
  const dropdown = document.getElementById('unit-picker-dropdown');
  dropdown.innerHTML = '';

  for (const list of lists) {
    const btn = document.createElement('button');
    btn.className   = 'list-picker-option';
    btn.textContent = list.name;
    btn.dataset.id  = list.id;
    btn.addEventListener('click', () => {
      closeAllPickers();
      selectList(list);
    });
    dropdown.appendChild(btn);
  }
}

function switchClass(cls) {
  selectedClass = cls;
  buildUnitPicker(cls);
  updateClassHighlight();

  // Auto-load first unit in this class
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

  // Group by subject
  const bySubject = {};
  for (const list of state.lists) {
    if (!bySubject[list.subject]) bySubject[list.subject] = [];
    bySubject[list.subject].push(list);
  }

  for (const [subject, lists] of Object.entries(bySubject)) {
    const section  = document.createElement('div');
    section.className = 'subject-section';

    const heading  = document.createElement('h2');
    heading.className = 'subject-title';
    heading.textContent = subject;
    section.appendChild(heading);

    for (const meta of lists) {
      const pct  = computeListProgress(meta.id, meta.wordCount, meta.type);
      const card = document.createElement('button');
      card.className = 'list-card';

      const info = document.createElement('div');
      info.className = 'list-card-info';

      const name = document.createElement('span');
      name.className = 'list-name';
      name.textContent = meta.name;

      const count = document.createElement('span');
      count.className = 'list-meta';
      count.textContent = meta.type === 'diagram'
        ? `${meta.wordCount} diagram questions`
        : meta.type === 'quiz'
          ? `${meta.wordCount} quiz questions`
          : `${meta.wordCount} words`;

      info.appendChild(name);
      info.appendChild(count);

      const bar  = document.createElement('div');
      bar.className = 'list-progress-bar';
      const fill = document.createElement('div');
      fill.className = 'list-progress-fill';
      fill.style.width = pct + '%';
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
// Mode selection screen
// ─────────────────────────────────────────────
async function selectList(meta) {
  try {
    const res = await fetch(meta.file);
    state.currentList = await res.json();
  } catch {
    alert('Could not load that list. Try again.');
    return;
  }

  // Rebuild unit picker if class changed
  if (state.currentList.subject !== selectedClass) {
    selectedClass = state.currentList.subject;
    buildUnitPicker(selectedClass);
  }
  updatePickerLabels();
  updateSubjectLabels();
  updateReferenceButton();
  renderListStats();
  closeTabs();
  showScreen('screen-mode');

  // Background-fetch other lists in same subject for 80/20 cross-unit mixing
  const subject = state.currentList.subject;
  for (const m of state.lists) {
    if (m.subject === subject && m.id !== state.currentList.id && m.type !== 'diagram' && m.type !== 'quiz' && !state.subjectCache[m.id]) {
      fetch(m.file).then(r => r.json()).then(l => { state.subjectCache[m.id] = l; }).catch(() => {});
    }
  }

  // Browse tile is always visible (quiz lists show terms reference)
  document.getElementById('tile-browse').classList.remove('hidden');
}

function renderListStats() {
  const container = document.getElementById('list-progress-summary');
  container.innerHTML = '';

  const stats = document.createElement('div');
  stats.className = 'progress-stats';

  const makestat = (num, label) => {
    const s = document.createElement('div');
    s.className = 'stat';
    s.innerHTML = `<span class="stat-num">${num}</span><span class="stat-label">${label}</span>`;
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
          totalCorrect   += rec.correct;
          totalAttempts  += t;
          if (rec.correct / t >= 0.8) mastered++;
        }
      }
    }
    const pct = totalAttempts > 0 ? Math.round((totalCorrect / totalAttempts) * 100) : 0;
    stats.appendChild(makestat(questions.length, 'questions'));
    stats.appendChild(makestat(seen,             'attempted'));
    stats.appendChild(makestat(`${mastered}`,    '≥80% accuracy'));
    stats.appendChild(makestat(totalAttempts > 0 ? `${pct}%` : '—', 'overall accuracy'));
    container.appendChild(stats);
    return;
  }

  const { id, pairs } = state.currentList;
  let comfortableEsEn = 0;
  let comfortableEnEs = 0;

  for (const pair of pairs) {
    const rec = getWordRecord(id, pair.es);
    if (rec.es_en.comfortable) comfortableEsEn++;
    if (rec.en_es.comfortable) comfortableEnEs++;
  }

  const { front, back } = listLabels();
  stats.appendChild(makestat(pairs.length,       'words'));
  stats.appendChild(makestat(comfortableEsEn,    `confident ${front}→${back}`));
  stats.appendChild(makestat(comfortableEnEs,    `confident ${back}→${front}`));
  container.appendChild(stats);
}

// ─────────────────────────────────────────────
// Quiz session
// ─────────────────────────────────────────────
function startSession(mode) {
  if (mode === 'match') {
    startMatch();
    return;
  }

  let session;
  if (mode === 'choice-en') {
    // Force back → front for every card
    session = shuffle([...state.currentList.pairs])
      .slice(0, SESSION_SIZE)
      .map(pair => ({ pair, direction: 'en_es' }));
  } else if (mode === 'type' && state.currentList.labels) {
    // Non-language lists: always show definition, type the term (short answer)
    session = shuffle([...state.currentList.pairs])
      .slice(0, SESSION_SIZE)
      .map(pair => ({ pair, direction: 'en_es' }));
  } else {
    session = buildSession(state.currentList);
  }

  if (session.length === 0) {
    alert('No words to study in this list.');
    return;
  }

  // 80/20 cross-unit mixing: replace up to 20% of session with cards from other units
  if (state.currentList.type !== 'diagram') {
    const otherPairs = Object.values(state.subjectCache).flatMap(l => l.pairs || []);
    if (otherPairs.length > 0) {
      const mixCount  = Math.max(1, Math.round(session.length * 0.2));
      const mainCount = session.length - mixCount;
      const mixed = shuffle(otherPairs)
        .slice(0, mixCount)
        .map(pair => ({ pair, direction: 'es_en' }));
      session = shuffle([...session.slice(0, mainCount), ...mixed]);
    }
  }

  state.currentMode    = mode;
  state.session        = session;
  state.sessionIndex   = 0;
  state.sessionResults = [];
  state.sessionHistory = [];

  showScreen('screen-quiz');
  updateAutoAdvanceUI();
  renderCard();
}

function updateProgressBar() {
  const pct = (state.sessionIndex / state.session.length) * 100;
  document.getElementById('progress-bar').style.width     = pct + '%';
  document.getElementById('progress-count').textContent   =
    `${state.sessionIndex}/${state.session.length}`;
}

function renderCard() {
  updateProgressBar();

  if (state.sessionIndex >= state.session.length) {
    showResults();
    return;
  }

  const { pair, direction } = state.session[state.sessionIndex];
  const prompt   = direction === 'es_en' ? pair.es : pair.en;
  const answer   = direction === 'es_en' ? pair.en : pair.es;
  const { front, back } = listLabels();
  const dirLabel = direction === 'es_en' ? `${front} → ${back}` : `${back} → ${front}`;

  state.currentAnswer = answer;
  state.answered      = false;

  updateNavBar();
  if      (state.currentMode === 'flashcard') renderFlashcard(dirLabel, prompt, answer, pair);
  else if (state.currentMode === 'type')      renderTypeIt(dirLabel, prompt);
  else if (state.currentMode.startsWith('choice')) renderChoice(dirLabel, prompt);
}

// ─────────────────────────────────────────────
// Flashcard mode
// ─────────────────────────────────────────────
function renderFlashcard(dirLabel, prompt, answer, pair) {
  state.flipped = false;
  showQuizMode('flashcard');

  document.getElementById('fc-direction').textContent = dirLabel;
  document.getElementById('fc-prompt').textContent    = prompt;
  document.getElementById('fc-answer').textContent    = answer;
  document.getElementById('fc-definition').classList.add('hidden');
  document.getElementById('fc-hint').classList.remove('hidden');
  document.getElementById('fc-answer-btns').classList.add('hidden');

  const diagramImg = document.getElementById('fc-diagram-img');
  const hasDiagram = !!(pair && pair.img);
  if (hasDiagram) {
    diagramImg.src = pair.img;
    diagramImg.classList.remove('hidden');
  } else {
    diagramImg.src = '';
    diagramImg.classList.add('hidden');
  }
  document.getElementById('flashcard').classList.toggle('fc-card--question', hasDiagram);
}

function flipCard() {
  if (state.flipped) {
    flashcardAnswer(true);
    return;
  }
  state.flipped = true;
  document.getElementById('fc-definition').classList.remove('hidden');
  document.getElementById('fc-answer-btns').classList.remove('hidden');
  document.getElementById('fc-hint').classList.add('hidden');
}

function flashcardAnswer(correct) {
  const { pair, direction } = state.session[state.sessionIndex];
  recordAnswer(state.currentList.id, pair.es, direction, correct);
  state.sessionHistory.push({ index: state.sessionIndex, pair, direction, recorded: true, correct });
  state.sessionResults.push({ pair, direction, correct });
  state.sessionIndex++;
  renderCard();
}

// ─────────────────────────────────────────────
// Type it mode
// ─────────────────────────────────────────────
function renderTypeIt(dirLabel, prompt) {
  showQuizMode('type');

  document.getElementById('type-direction').textContent = dirLabel;
  document.getElementById('type-prompt').textContent    = prompt;

  const input = document.getElementById('type-input');
  input.value       = '';
  input.disabled    = false;
  input.placeholder = state.currentList.labels ? 'Type the term…' : 'Type the translation…';
  input.focus();

  document.getElementById('type-feedback').className = 'feedback hidden';
  document.getElementById('type-next').classList.add('hidden');
}

function checkTypeAnswer() {
  // If already answered, Enter/Check acts as "Next"
  if (state.answered) {
    advanceCard();
    return;
  }

  const input      = document.getElementById('type-input');
  const userAnswer = input.value;
  if (!userAnswer.trim()) return;

  state.answered = true;
  input.disabled = true;

  const correct  = normalize(userAnswer) === normalize(state.currentAnswer);
  const feedback = document.getElementById('type-feedback');
  feedback.className   = `feedback ${correct ? 'feedback-correct' : 'feedback-wrong'}`;
  feedback.textContent = correct ? 'Correct!' : `Answer: ${state.currentAnswer}`;

  document.getElementById('type-next').classList.remove('hidden');

  const { pair, direction } = state.session[state.sessionIndex];
  recordAnswer(state.currentList.id, pair.es, direction, correct);
  state.sessionHistory.push({ index: state.sessionIndex, pair, direction, recorded: true, correct });
  state.sessionResults.push({ pair, direction, correct });
  updateNavBar();

  // Auto-advance on correct answers only
  if (correct && state.settings.autoAdvanceDelay > 0) {
    setTimeout(() => {
      if (state.answered && state.currentMode === 'type') {
        advanceCard();
      }
    }, state.settings.autoAdvanceDelay);
  }
}

// ─────────────────────────────────────────────
// Multiple choice mode
// ─────────────────────────────────────────────
function renderChoice(dirLabel, prompt) {
  showQuizMode('choice');

  document.getElementById('choice-direction').textContent = dirLabel;
  document.getElementById('choice-prompt').textContent    = prompt;
  document.getElementById('choice-next').classList.add('hidden');

  const { direction } = state.session[state.sessionIndex];
  const correct       = state.currentAnswer;
  const allPairs      = state.currentList.pairs;

  const wrongPool  = allPairs
    .map(p => direction === 'es_en' ? p.en : p.es)
    .filter(a => normalize(a) !== normalize(correct));

  const distractors = shuffle(wrongPool).slice(0, 3);
  const choices     = shuffle([correct, ...distractors]);

  const grid = document.getElementById('choices-grid');
  grid.innerHTML = '';

  for (const choice of choices) {
    const btn  = document.createElement('button');
    btn.className   = 'choice-btn';
    btn.textContent = choice;
    btn.addEventListener('click', () => checkChoice(btn, choice));
    grid.appendChild(btn);
  }
}

function checkChoice(btn, chosen) {
  if (state.answered) {
    advanceCard();
    return;
  }
  state.answered = true;

  const correct = normalize(chosen) === normalize(state.currentAnswer);

  document.querySelectorAll('.choice-btn').forEach(b => {
    b.disabled = true;
    if (normalize(b.textContent) === normalize(state.currentAnswer)) {
      b.classList.add('choice-correct');
    }
  });

  if (!correct) btn.classList.add('choice-wrong');

  document.getElementById('choice-next').classList.remove('hidden');

  const { pair, direction } = state.session[state.sessionIndex];
  recordAnswer(state.currentList.id, pair.es, direction, correct);
  state.sessionHistory.push({ index: state.sessionIndex, pair, direction, recorded: true, correct });
  state.sessionResults.push({ pair, direction, correct });
  updateNavBar();

  // Auto-advance on correct answers only
  if (correct && state.settings.autoAdvanceDelay > 0) {
    setTimeout(() => {
      if (state.answered && state.currentMode.startsWith('choice')) {
        advanceCard();
      }
    }, state.settings.autoAdvanceDelay);
  }
}

// ─────────────────────────────────────────────
// Advance
// ─────────────────────────────────────────────
function advanceCard() {
  state.sessionIndex++;
  renderCard();
}

// ─────────────────────────────────────────────
// MC Quiz mode
// ─────────────────────────────────────────────
function getQuizRecord(listId, questionId) {
  if (!state.progress[listId])                 state.progress[listId] = {};
  if (!state.progress[listId][questionId])     state.progress[listId][questionId] = { correct: 0, incorrect: 0 };
  return state.progress[listId][questionId];
}

function recordQuizAnswer(listId, questionId, correct) {
  const rec = getQuizRecord(listId, questionId);
  if (correct) rec.correct++;
  else         rec.incorrect++;
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

function buildMcqSession(list) {
  const pool = [];
  for (const q of list.questions) {
    const w = getMcqWeight(list.id, q.id);
    for (let i = 0; i < w; i++) pool.push(q);
  }
  const shuffled = shuffle(pool);
  // Deduplicate by id while preserving order, limit to SESSION_SIZE
  const seen    = new Set();
  const session = [];
  for (const q of shuffled) {
    if (seen.has(q.id)) continue;
    seen.add(q.id);
    session.push(q);
    if (session.length >= SESSION_SIZE) break;
  }
  return session;
}

function startMcQuiz(gradeMode) {
  const list = state.currentList;
  if (!list || list.type !== 'quiz') return;

  state.mcqSession   = buildMcqSession(list);
  state.mcqIndex     = 0;
  state.mcqResults   = [];
  state.mcqGradeMode = gradeMode || 'inline'; // 'inline' | 'end'
  state.currentMode  = 'mc-quiz';

  document.getElementById('progress-bar').style.width   = '0%';
  document.getElementById('progress-count').textContent = `0/${state.mcqSession.length}`;

  updateNavBar();

  showScreen('screen-quiz');
  renderMcqCard();
}

function renderMcqCard() {
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
    diagramImg.src = q.img;
    diagramImg.classList.remove('hidden');
  } else {
    diagramImg.src = '';
    diagramImg.classList.add('hidden');
  }

  document.getElementById('mcq-question').textContent = q.q;
  document.getElementById('mcq-feedback').classList.add('hidden');
  document.getElementById('mcq-next').classList.add('hidden');

  // Build shuffled choices: correct + 3 incorrect
  const choices = shuffle([
    { text: q.correct,        isCorrect: true,  wrongIdx: -1 },
    { text: q.incorrect[0],   isCorrect: false, wrongIdx: 0  },
    { text: q.incorrect[1],   isCorrect: false, wrongIdx: 1  },
    { text: q.incorrect[2],   isCorrect: false, wrongIdx: 2  },
  ]);

  const container = document.getElementById('mcq-choices');
  container.innerHTML = '';

  choices.forEach((choice, i) => {
    const btn = document.createElement('button');
    btn.className   = 'mcq-choice-btn';
    btn.textContent = choice.text;
    btn.addEventListener('click', () => selectMcqAnswer(btn, choice, choices));
    container.appendChild(btn);
  });
}

function selectMcqAnswer(btn, choice, allChoices) {
  // Ignore if already answered
  if (!document.getElementById('mcq-next').classList.contains('hidden')) return;

  const q         = state.mcqSession[state.mcqIndex];
  const isCorrect = choice.isCorrect;

  // Always disable all buttons
  document.querySelectorAll('.mcq-choice-btn').forEach(b => { b.disabled = true; });

  // Record answer
  recordQuizAnswer(state.currentList.id, q.id, isCorrect);
  state.mcqResults.push({
    question: q,
    chosen:   choice.text,
    correct:  isCorrect,
    whyWrong: choice.wrongIdx >= 0 ? q.why_wrong[choice.wrongIdx] : null,
  });

  if (state.mcqGradeMode === 'end') {
    // Exam mode: no feedback, auto-advance after brief highlight
    btn.classList.add('mcq-choice-selected');
    setTimeout(() => advanceMcqCard(), 400);
  } else {
    // Inline mode: show correct/wrong colours + explanation
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
    } else {
      badge.textContent = 'Incorrect';
      badge.className   = 'mcq-feedback-badge mcq-badge--wrong';
      const whyWrong    = choice.wrongIdx >= 0 ? q.why_wrong[choice.wrongIdx] : '';
      explanation.innerHTML = `<strong>Why that's wrong:</strong> ${whyWrong}<br><br><strong>Correct answer:</strong> ${q.correct}<br>${q.why_correct}`;
    }

    document.getElementById('mcq-feedback').classList.remove('hidden');
    document.getElementById('mcq-next').classList.remove('hidden');
  }
}

function advanceMcqCard() {
  state.mcqIndex++;
  renderMcqCard();
}

function skipMcqCard() {
  // Only skip if not yet answered (Next button hidden means unanswered)
  if (!document.getElementById('mcq-next').classList.contains('hidden')) return;
  // Remove the question entirely — skipped questions are not revisited or scored
  state.mcqSession.splice(state.mcqIndex, 1);
  renderMcqCard();
}

function showMcqResults() {
  const results  = state.mcqResults;
  const numRight = results.filter(r => r.correct).length;
  const total    = results.length;
  const pct      = total > 0 ? Math.round((numRight / total) * 100) : 0;

  const grade = pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 60 ? 'D' : 'F';

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

  // For quiz mode: hide Study Missed (not applicable), show Again
  document.getElementById('btn-retry-missed').style.display = 'none';
  document.getElementById('results-title').textContent = 'Quiz Results';
  showScreen('screen-results');
}

// ─────────────────────────────────────────────
// Match mode
// ─────────────────────────────────────────────
function startMatch() {
  state.currentMode    = 'match';
  state.sessionResults = [];

  const pairs = shuffle([...state.currentList.pairs]).slice(0, state.settings.matchSize);
  state.matchPairs        = pairs;
  state.matchSelected     = null;
  state.matchMatched      = new Set();
  state.matchFirstAttempt = pairs.map(() => true);
  state.matchFlashing     = false;

  document.getElementById('progress-bar').style.width   = '0%';
  document.getElementById('progress-count').textContent = `0/${pairs.length}`;

  showScreen('screen-quiz');
  updateAutoAdvanceUI();
  renderMatch();
}

function renderMatch() {
  showQuizMode('match');
  const { front: mFront, back: mBack } = listLabels();
  document.getElementById('match-direction').textContent = `${mFront} — ${mBack}`;
  document.getElementById('match-complete').classList.add('hidden');

  const esCol = document.getElementById('match-col-es');
  const enCol = document.getElementById('match-col-en');
  esCol.innerHTML = '';
  enCol.innerHTML = '';

  // EN column in a different shuffle order
  const enOrder = shuffle(state.matchPairs.map((_, i) => i));

  state.matchPairs.forEach((pair, pairIndex) => {
    const esBtn  = document.createElement('button');
    esBtn.className   = 'match-item';
    esBtn.dataset.pair = pairIndex;
    esBtn.addEventListener('click', () => selectEsItem(pairIndex));
    const esSpan = document.createElement('span');
    esSpan.className  = 'match-item-label';
    esSpan.textContent = pair.es;
    esBtn.appendChild(esSpan);
    esCol.appendChild(esBtn);
  });

  enOrder.forEach(pairIndex => {
    const enBtn  = document.createElement('button');
    enBtn.className   = 'match-item';
    enBtn.dataset.pair = pairIndex;
    enBtn.addEventListener('click', () => selectEnItem(pairIndex));
    const enSpan = document.createElement('span');
    enSpan.className  = 'match-item-label';
    enSpan.textContent = state.matchPairs[pairIndex].en;
    enBtn.appendChild(enSpan);
    enCol.appendChild(enBtn);
  });
}

function esItemBtn(pairIndex) {
  return document.querySelector(`#match-col-es .match-item[data-pair="${pairIndex}"]`);
}

function enItemBtn(pairIndex) {
  return document.querySelector(`#match-col-en .match-item[data-pair="${pairIndex}"]`);
}

function selectEsItem(pairIndex) {
  if (state.matchFlashing) return;
  if (state.matchMatched.has(pairIndex)) return;

  // Toggle deselect
  if (state.matchSelected === pairIndex) {
    state.matchSelected = null;
    esItemBtn(pairIndex).classList.remove('selected');
    return;
  }

  // Clear previous selection
  if (state.matchSelected !== null) {
    esItemBtn(state.matchSelected).classList.remove('selected');
  }

  state.matchSelected = pairIndex;
  esItemBtn(pairIndex).classList.add('selected');
}

function selectEnItem(pairIndex) {
  if (state.matchFlashing) return;
  if (state.matchMatched.has(pairIndex)) return;
  if (state.matchSelected === null) return;

  const selectedEs = state.matchSelected;

  if (selectedEs === pairIndex) {
    // Correct match
    state.matchSelected = null;
    state.matchMatched.add(pairIndex);

    esItemBtn(pairIndex).classList.remove('selected');
    esItemBtn(pairIndex).classList.add('matched');
    esItemBtn(pairIndex).disabled = true;
    enItemBtn(pairIndex).classList.add('matched');
    enItemBtn(pairIndex).disabled = true;

    const correct = state.matchFirstAttempt[pairIndex];
    const pair    = state.matchPairs[pairIndex];
    recordAnswer(state.currentList.id, pair.es, 'es_en', correct);
    state.sessionResults.push({ pair, direction: 'es_en', correct });

    updateMatchProgress();

    if (state.matchMatched.size === state.matchPairs.length) {
      document.getElementById('match-complete').classList.remove('hidden');
    }
  } else {
    // Wrong
    state.matchFirstAttempt[selectedEs] = false;
    state.matchFlashing = true;

    esItemBtn(selectedEs).classList.remove('selected');
    esItemBtn(selectedEs).classList.add('wrong');
    enItemBtn(pairIndex).classList.add('wrong');

    setTimeout(() => {
      esItemBtn(selectedEs).classList.remove('wrong');
      enItemBtn(pairIndex).classList.remove('wrong');
      state.matchSelected = null;
      state.matchFlashing = false;
    }, 600);
  }
}

// ─────────────────────────────────────────────
// Stats mode
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
  const listId = state.currentList.id;

  if (state.currentList.type === 'quiz') {
    renderQuizStats(listId);
    return;
  }

  const rows = state.currentList.pairs.map(pair => {
    const rec       = getWordRecord(listId, pair.es);
    const correct   = rec.es_en.correct   + rec.en_es.correct;
    const incorrect = rec.es_en.incorrect + rec.en_es.incorrect;
    const total     = correct + incorrect;
    const accuracy  = total > 0 ? Math.round((correct / total) * 100) : null;
    return { pair, correct, incorrect, total, accuracy };
  });

  if (currentStatsSort === 'missed') {
    rows.sort((a, b) => {
      if (a.total === 0 && b.total === 0) return 0;
      if (a.total === 0) return 1;
      if (b.total === 0) return -1;
      return b.incorrect - a.incorrect || a.pair.es.localeCompare(b.pair.es);
    });
  } else if (currentStatsSort === 'correct') {
    rows.sort((a, b) => {
      if (a.total === 0 && b.total === 0) return 0;
      if (a.total === 0) return 1;
      if (b.total === 0) return -1;
      return b.correct - a.correct || a.pair.es.localeCompare(b.pair.es);
    });
  } else {
    rows.sort((a, b) => a.pair.es.localeCompare(b.pair.es));
  }

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

    addCell(r.pair.es, 'stats-es');
    addCell(r.pair.en);
    addCell(r.correct   > 0 ? r.correct   : '—', 'stats-num');
    addCell(r.incorrect > 0 ? r.incorrect : '—', 'stats-num');
    addCell(accText, `stats-acc ${accClass}`);

    tbody.appendChild(row);
  }

  document.querySelectorAll('.sort-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById('sort-' + currentStatsSort).classList.add('active');
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

  // Update table headers
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

    addCell(r.q.q,         'stats-es');
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
// Browse mode
// ─────────────────────────────────────────────
function startBrowse() {
  switchTab('browse');
}

let browseSort     = 'none';
let browseSortDir  = 'asc';

function renderBrowse() {
  if (state.currentList.type === 'quiz') {
    renderTermsBrowse();
    return;
  }

  let pairs = [...state.currentList.pairs];
  if (browseSort !== 'none') {
    pairs.sort((a, b) => {
      const cmp = a[browseSort].localeCompare(b[browseSort]);
      return browseSortDir === 'asc' ? cmp : -cmp;
    });
  }

  const tbody = document.getElementById('word-table-body');
  tbody.innerHTML = '';
  for (const pair of pairs) {
    const row = document.createElement('tr');
    const es  = document.createElement('td');
    const en  = document.createElement('td');
    es.textContent = pair.es;
    en.textContent = pair.en;
    row.appendChild(es);
    row.appendChild(en);
    tbody.appendChild(row);
  }

  ['es', 'en'].forEach(col => {
    const th = document.getElementById('browse-sort-' + col);
    th.classList.remove('sort-asc', 'sort-desc');
    const ind = th.querySelector('.sort-indicator');
    if (browseSort === col) {
      th.classList.add(browseSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      ind.textContent = browseSortDir === 'asc' ? ' ↑' : ' ↓';
    } else {
      ind.textContent = ' ↕';
    }
  });
}

function renderTermsBrowse() {
  const terms = state.currentList.terms || [];

  // Update column headers
  const thFront = document.getElementById('browse-sort-es');
  const thBack  = document.getElementById('browse-sort-en');
  if (thFront) thFront.innerHTML = `Term / Question <span class="sort-indicator"></span>`;
  if (thBack)  thBack.innerHTML  = `Definition / Answer <span class="sort-indicator"></span>`;

  const tbody = document.getElementById('word-table-body');
  tbody.innerHTML = '';
  for (const t of terms) {
    const row = document.createElement('tr');
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

function setBrowseSort(col) {
  if (browseSort === col) {
    browseSortDir = browseSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    browseSort    = col;
    browseSortDir = 'asc';
  }
  renderBrowse();
}

function updateMatchProgress() {
  const matched = state.matchMatched.size;
  const total   = state.matchPairs.length;
  document.getElementById('progress-bar').style.width   = `${(matched / total) * 100}%`;
  document.getElementById('progress-count').textContent = `${matched}/${total}`;
}

// ─────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────
function showResults() {
  document.getElementById('results-title').textContent = 'Session Complete';
  document.getElementById('btn-retry-missed').style.display = '';
  showScreen('screen-results');

  const results = state.sessionResults;
  const correct = results.filter(r => r.correct).length;
  const total   = results.length;
  const pct     = total > 0 ? Math.round((correct / total) * 100) : 0;

  document.getElementById('results-summary').innerHTML = `
    <div class="results-score">
      <span class="score-big">${pct}%</span>
      <span class="score-sub">${correct} of ${total} correct</span>
    </div>
  `;

  const missed  = results.filter(r => !r.correct);
  const details = document.getElementById('results-details');

  if (missed.length === 0) {
    details.innerHTML = '<p class="all-correct">Perfect session!</p>';
  } else {
    details.innerHTML = '';

    const heading = document.createElement('h3');
    heading.textContent = 'Review these:';
    details.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'missed-list';

    for (const r of missed) {
      const promptText = r.direction === 'es_en' ? r.pair.es : r.pair.en;
      const answerText = r.direction === 'es_en' ? r.pair.en : r.pair.es;

      const item   = document.createElement('div');
      item.className = 'missed-item';

      const p = document.createElement('span');
      p.className   = 'missed-prompt';
      p.textContent = promptText;

      const arrow  = document.createElement('span');
      arrow.className   = 'missed-arrow';
      arrow.textContent = '→';

      const a = document.createElement('span');
      a.className   = 'missed-answer';
      a.textContent = answerText;

      item.appendChild(p);
      item.appendChild(arrow);
      item.appendChild(a);
      list.appendChild(item);
    }

    details.appendChild(list);
  }

  document.getElementById('btn-retry-missed').style.display =
    missed.length > 0 ? '' : 'none';
}

function retryMissed() {
  const missed = state.sessionResults.filter(r => !r.correct);
  state.session        = missed;
  state.sessionIndex   = 0;
  state.sessionResults = [];
  if (state.currentMode === 'match') state.currentMode = 'flashcard';
  showScreen('screen-quiz');
  updateAutoAdvanceUI();
  renderCard();
}

function restartSession() {
  if (state.currentMode === 'mc-quiz') {
    startMcQuiz(state.mcqGradeMode);
  } else {
    startSession(state.currentMode);
  }
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
  } catch {
    // Network unavailable or local file — silently ignore
  }
}

setInterval(checkForUpdate, 10 * 60 * 1000); // re-check every 10 minutes

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

  // Flashcard
  document.getElementById('flashcard').addEventListener('click', flipCard);
  document.getElementById('fc-missed').addEventListener('click', () => flashcardAnswer(false));
  document.getElementById('fc-got-it').addEventListener('click', () => flashcardAnswer(true));

  // Type it
  document.getElementById('type-check').addEventListener('click', checkTypeAnswer);
  document.getElementById('type-next').addEventListener('click', advanceCard);
  document.getElementById('type-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') checkTypeAnswer();
  });

  // Multiple choice
  document.getElementById('choice-next').addEventListener('click', advanceCard);

  // MC Quiz
  document.getElementById('mcq-next').addEventListener('click', advanceMcqCard);

  // Keyboard shortcuts for quiz screen
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const overlay = document.getElementById('ref-overlay');
      if (!overlay.classList.contains('hidden')) { hideReference(); return; }
      if (state.currentMode) { confirmQuit(); return; }
    }
    const inQuiz = state.currentMode && state.currentMode !== 'match';
    if (inQuiz && e.key === 'ArrowLeft'  && !e.metaKey && !e.altKey) { e.preventDefault(); goBack(); }
    if (inQuiz && e.key === 'ArrowRight' && !e.metaKey && !e.altKey) { e.preventDefault(); skipCard(); }
    if (state.currentMode && state.currentMode.startsWith('choice') && state.answered && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      advanceCard();
    }
  });

  // Match
  document.getElementById('match-done-btn').addEventListener('click', showResults);
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
// Reference chart overlay
// ─────────────────────────────────────────────
function updateReferenceButton() {
  const btn = document.getElementById('ref-btn');
  const ref = state.currentList?.reference;
  btn.classList.add('hidden');
  if (!ref) return;
  const img = document.getElementById('ref-img');
  img.onload  = () => btn.classList.remove('hidden');
  img.onerror = () => btn.classList.add('hidden');
  img.src = ref;
}

function showReference() {
  document.getElementById('ref-overlay').classList.remove('hidden');
}

function hideReference() {
  document.getElementById('ref-overlay').classList.add('hidden');
}

// ─────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);
