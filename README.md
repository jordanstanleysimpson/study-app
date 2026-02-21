# Study App

**Live App:** [https://jordanstanleysimpson.github.io/study-app/](https://jordanstanleysimpson.github.io/study-app/)

A progressive web app for vocabulary study, starting with Spanish ↔ English. Built to be fast, intuitive, and installable on any device.

## Features

- **5 Study Modes:**
  - 💳 **Flashcards** - Tap to flip and self-assess
  - ⌨️ **Type It** - Practice spelling the translation
  - ✓ **Multiple Choice** (Spanish → English) - Auto-advances after 1.5s
  - ✓ **Multiple Choice** (English → Spanish) - Reverse direction practice
  - 🔗 **Match** - Connect Spanish words to English translations

- **Smart Progress Tracking:**
  - Spanish → English drilled first
  - After 3 correct answers in a row, English → Spanish unlocks
  - Missed words weighted heavier in future sessions
  - All progress saved locally in browser

- **Browse & Stats:**
  - Browse all vocabulary with sortable columns
  - View detailed statistics (most missed, most correct, accuracy %)
  - Track your progress across all study modes

---

## Adding a new word list

This is done in an interactive Claude session — no manual JSON editing required.

### Step 1 — Take a photo of the printed list

Get a clear photo of the word list (typed text works best).

### Step 2 — Open a Claude session and share the photo

Paste this prompt (adjust the unit name/class as needed):

```
I have a new Spanish vocab list to add to the study app at
~/Dev/Projects/study-app

Here is the photo. Please:
1. Parse the word pairs (Spanish / English)
2. Create data/spanish-unit-N.json following the format below
3. Add an entry to the top of the lists array in data/index.json

JSON format for the list file:
{
  "id": "spanish-unit-N",
  "name": "Unit N - [topic]",
  "subject": "Spanish",
  "created": "YYYY-MM-DD",
  "pairs": [
    { "es": "spanish word", "en": "english word" }
  ]
}

Entry format for data/index.json:
{
  "id": "spanish-unit-N",
  "name": "Unit N - [topic]",
  "subject": "Spanish",
  "created": "YYYY-MM-DD",
  "wordCount": N,
  "file": "data/spanish-unit-N.json"
}
```

### Step 3 — Commit and push

```bash
git add data/
git commit -m "Add Spanish Unit N"
git push
```

GitHub Pages auto-deploys within ~30 seconds.

---

## Data file format

**`data/index.json`** — the list of all available units (newest first in the array):

```json
{
  "lists": [
    {
      "id": "spanish-unit-2",
      "name": "Unit 2 - Colors",
      "subject": "Spanish",
      "created": "2026-03-01",
      "wordCount": 15,
      "file": "data/spanish-unit-2.json"
    }
  ]
}
```

**`data/spanish-unit-N.json`** — a single unit's word pairs:

```json
{
  "id": "spanish-unit-2",
  "name": "Unit 2 - Colors",
  "subject": "Spanish",
  "created": "2026-03-01",
  "pairs": [
    { "es": "rojo", "en": "red" },
    { "es": "azul", "en": "blue" }
  ]
}
```

---

## Running locally

The app uses `fetch()` to load data files, so you can't open `index.html` directly from the filesystem. Spin up a local server:

```bash
cd ~/Dev/Projects/study-app
python3 -m http.server 3000
```

Then open [http://localhost:3000](http://localhost:3000).

---

## Deployment

This app is deployed on **GitHub Pages**. Any push to the `main` branch automatically deploys to production within ~30 seconds.

**Live URL:** [https://jordanstanleysimpson.github.io/study-app/](https://jordanstanleysimpson.github.io/study-app/)

### Initial setup (already configured):

```bash
# Enable GitHub Pages via CLI
gh api repos/jordanstanleysimpson/study-app/pages -X POST \
  --field 'source[branch]=main' --field 'source[path]=/'
```

Or manually: **Settings → Pages → Deploy from branch → main → / (root)**

---

## PWA Features

The app includes a Progressive Web App manifest and can be installed on mobile devices:

- **iOS:** Tap share → "Add to Home Screen"
- **Android:** Tap menu → "Install app" or "Add to Home Screen"
- **Desktop:** Look for install icon in address bar

Once installed, the app works offline and loads instantly from the home screen.
