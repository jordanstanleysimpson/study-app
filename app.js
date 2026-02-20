'use strict';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const COMFORT_STREAK  = 3;   // correct-in-a-row to unlock the reverse direction
const SESSION_SIZE    = 20;  // max cards per session
const STORAGE_KEY     = 'study-app-progress';
const APP_VERSION     = '2026-02-20T00:00:00Z';
const INSTALL_TIP_KEY = 'study-app-install-dismissed';

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
const state = {
  lists:          [],     // metadata from index.json
  currentList:    null,   // full list object { id, pairs, … }
  currentMode:    null,   // 'flashcard' | 'type' | 'choice'
  session:        [],     // [{ pair: {es,en}, direction: 'es_en'|'en_es' }, …]
  sessionIndex:   0,
  sessionResults: [],     // [{ pair, direction, correct: bool }, …]
  progress:       {},     // persisted to localStorage
  currentAnswer:  null,   // correct answer for the active card
  answered:       false,  // has the current card been evaluated?
  flipped:        false,  // flashcard flip state
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

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─────────────────────────────────────────────
// Progress — localStorage
// ─────────────────────────────────────────────
function loadProgress() {
  try {
    state.progress = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    state.progress = {};
  }
}

function saveProgress() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
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
  document.getElementById('picker-bar').classList.toggle('hidden', id === 'screen-home');
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
  ['study', 'browse', 'stats'].forEach(t => {
    document.getElementById('tab-' + t).classList.toggle('hidden', t !== name);
    document.getElementById('tab-btn-' + t).classList.toggle('active', t === name);
  });
  if (name === 'browse') renderBrowse();
  if (name === 'stats')  renderStats();
}

function confirmQuit() {
  showScreen('screen-mode');
}

// ─────────────────────────────────────────────
// Home screen
// ─────────────────────────────────────────────
async function init() {
  loadProgress();
  showScreen('screen-home');
  setupEventListeners();
  checkForUpdate();

  try {
    const res  = await fetch('data/index.json');
    const data = await res.json();
    // Newest first
    state.lists = data.lists.sort((a, b) => b.created.localeCompare(a.created));
    buildClassPicker();
    renderHome();
  } catch {
    document.getElementById('lists-container').innerHTML =
      '<p class="muted-text">Could not load lists.<br>Open via GitHub Pages or a local server (not directly from the filesystem).</p>';
  }

  showInstallTip();
}

function computeListProgress(listId, wordCount) {
  if (wordCount === 0 || !state.progress[listId]) return 0;
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
  const lists    = state.lists.filter(l => l.subject === subject);
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
      const pct  = computeListProgress(meta.id, meta.wordCount);
      const card = document.createElement('button');
      card.className = 'list-card';

      const info = document.createElement('div');
      info.className = 'list-card-info';

      const name = document.createElement('span');
      name.className = 'list-name';
      name.textContent = meta.name;

      const count = document.createElement('span');
      count.className = 'list-meta';
      count.textContent = `${meta.wordCount} words`;

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
  renderListStats();
  switchTab('study');
  showScreen('screen-mode');
}

function renderListStats() {
  const { id, pairs } = state.currentList;
  let comfortableEsEn = 0;
  let comfortableEnEs = 0;

  for (const pair of pairs) {
    const rec = getWordRecord(id, pair.es);
    if (rec.es_en.comfortable) comfortableEsEn++;
    if (rec.en_es.comfortable) comfortableEnEs++;
  }

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

  stats.appendChild(makestat(pairs.length,       'words'));
  stats.appendChild(makestat(comfortableEsEn,    'confident es→en'));
  stats.appendChild(makestat(comfortableEnEs,    'confident en→es'));
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
    // Force English → Spanish for every card
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

  state.currentMode    = mode;
  state.session        = session;
  state.sessionIndex   = 0;
  state.sessionResults = [];

  showScreen('screen-quiz');
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
  const dirLabel = direction === 'es_en' ? 'Spanish → English' : 'English → Spanish';

  state.currentAnswer = answer;
  state.answered      = false;

  if      (state.currentMode === 'flashcard') renderFlashcard(dirLabel, prompt, answer);
  else if (state.currentMode === 'type')      renderTypeIt(dirLabel, prompt);
  else if (state.currentMode === 'choice')    renderChoice(dirLabel, prompt);
}

// ─────────────────────────────────────────────
// Flashcard mode
// ─────────────────────────────────────────────
function renderFlashcard(dirLabel, prompt, answer) {
  state.flipped = false;
  showQuizMode('flashcard');

  document.getElementById('fc-direction').textContent = dirLabel;
  document.getElementById('fc-prompt').textContent    = prompt;
  document.getElementById('fc-answer').textContent    = answer;
  document.getElementById('flashcard-inner').classList.remove('flipped');
  document.getElementById('fc-hint').classList.remove('hidden');
  document.getElementById('fc-answer-btns').classList.add('hidden');
}

function flipCard() {
  if (state.flipped) {
    flashcardAnswer(true);
    return;
  }
  state.flipped = true;
  document.getElementById('flashcard-inner').classList.add('flipped');
  document.getElementById('fc-answer-btns').classList.remove('hidden');
  document.getElementById('fc-hint').classList.add('hidden');
}

function flashcardAnswer(correct) {
  const { pair, direction } = state.session[state.sessionIndex];
  recordAnswer(state.currentList.id, pair.es, direction, correct);
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
  input.value    = '';
  input.disabled = false;
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
  state.sessionResults.push({ pair, direction, correct });
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
  state.sessionResults.push({ pair, direction, correct });

  // Auto-advance after showing feedback
  setTimeout(() => {
    if (state.answered && state.currentMode === 'choice') {
      advanceCard();
    }
  }, 1000);
}

// ─────────────────────────────────────────────
// Advance
// ─────────────────────────────────────────────
function advanceCard() {
  state.sessionIndex++;
  renderCard();
}

// ─────────────────────────────────────────────
// Match mode
// ─────────────────────────────────────────────
function startMatch() {
  state.currentMode    = 'match';
  state.sessionResults = [];

  const pairs = shuffle([...state.currentList.pairs]).slice(0, 20);
  state.matchPairs        = pairs;
  state.matchSelected     = null;
  state.matchMatched      = new Set();
  state.matchFirstAttempt = pairs.map(() => true);
  state.matchFlashing     = false;

  document.getElementById('progress-bar').style.width   = '0%';
  document.getElementById('progress-count').textContent = `0/${pairs.length}`;

  showScreen('screen-quiz');
  renderMatch();
}

function renderMatch() {
  showQuizMode('match');
  document.getElementById('match-direction').textContent = 'Spanish — English';
  document.getElementById('match-complete').classList.add('hidden');

  const esCol = document.getElementById('match-col-es');
  const enCol = document.getElementById('match-col-en');
  esCol.innerHTML = '';
  enCol.innerHTML = '';

  // EN column in a different shuffle order
  const enOrder = shuffle(state.matchPairs.map((_, i) => i));

  state.matchPairs.forEach((pair, pairIndex) => {
    const esBtn = document.createElement('button');
    esBtn.className = 'match-item';
    esBtn.textContent = pair.es;
    esBtn.dataset.pair = pairIndex;
    esBtn.addEventListener('click', () => selectEsItem(pairIndex));
    esCol.appendChild(esBtn);
  });

  enOrder.forEach(pairIndex => {
    const enBtn = document.createElement('button');
    enBtn.className = 'match-item';
    enBtn.textContent = state.matchPairs[pairIndex].en;
    enBtn.dataset.pair = pairIndex;
    enBtn.addEventListener('click', () => selectEnItem(pairIndex));
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

// ─────────────────────────────────────────────
// Browse mode
// ─────────────────────────────────────────────
function startBrowse() {
  switchTab('browse');
}

let browseSort     = 'none';
let browseSortDir  = 'asc';

function renderBrowse() {
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
  renderCard();
}

function restartSession() {
  startSession(state.currentMode);
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

  // Keyboard shortcuts for quiz screen
  document.addEventListener('keydown', e => {
    if (state.currentMode === 'choice' && state.answered && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      advanceCard();
    }
  });

  // Match
  document.getElementById('match-done-btn').addEventListener('click', showResults);
}

// ─────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);
