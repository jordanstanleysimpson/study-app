# Study App

A vocab study tool for kids. Start with Spanish ↔ English, built to grow into other subjects.

## How it works

- Pick a word list (organized by subject and unit, newest first)
- Choose a quiz mode: **Flashcards**, **Type It**, or **Multiple Choice**
- The app drills Spanish → English first; once you nail a word 3 times in a row, English → Spanish unlocks for it
- Progress is saved in the browser so missed words get drilled more

---

## Adding a new word list

This is done in an interactive Claude session — no manual JSON editing required.

### Step 1 — Take a photo of the printed list

Get a clear photo of the word list (typed text works best).

### Step 2 — Open a Claude session and share the photo

Paste this prompt (adjust the unit name/class as needed):

```
I have a new Spanish vocab list to add to the study app at
~/Dev/projects/jordanstanleysimpson/study-app

Here is the photo. Please:
1. Parse the word pairs (Spanish / English)
2. Create data/spanish-unit-2.json following the format below
3. Add an entry to the top of the lists array in data/index.json

JSON format for the list file:
{
  "id": "spanish-unit-2",
  "name": "Unit 2 - [topic]",
  "subject": "Spanish",
  "created": "YYYY-MM-DD",
  "pairs": [
    { "es": "spanish word", "en": "english word" }
  ]
}

Entry format for data/index.json:
{
  "id": "spanish-unit-2",
  "name": "Unit 2 - [topic]",
  "subject": "Spanish",
  "created": "YYYY-MM-DD",
  "wordCount": N,
  "file": "data/spanish-unit-2.json"
}
```

### Step 3 — Commit and push

```bash
git add data/
git commit -m "Add Spanish Unit 2"
git push
```

GitHub Pages auto-publishes within a minute or two.

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

The app uses `fetch()` to load data files, so you can't open `index.html` directly from the filesystem. Spin up a quick local server instead:

```bash
cd ~/Dev/projects/jordanstanleysimpson/study-app
python3 -m http.server 3000
```

Then open [http://localhost:3000](http://localhost:3000).

---

## GitHub Pages setup

1. Push the repo to GitHub
2. Go to **Settings → Pages**
3. Set source to **Deploy from a branch → main → / (root)**
4. The site will be live at `https://<username>.github.io/<repo-name>/`
