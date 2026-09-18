# WorkLogs

A work journal stored locally by default. **One screen**: journal on the left,
writing in the center, tasks on the right. No account is required for local use.
The development branch adds rich documents and optional Google Drive integration.

```
┌───────────────────────────────────────────────────────────────────────────┐
│ WorkLogs   [search…]            4 entries this week · 3 todo          ☀ ⬇ │
├───────────────┬───────────────────────────────────┬───────────────────────┤
│ All · Personal│  Site visit report                │ [new task…]           │
│ + New         │  [date] [project] [Write│Read]    │ TODO  3               │
│               │  ─────────────────────────────    │  ☐ Chase the quote    │
│ TODAY         │                                   │ DOING 1               │
│ • Report      │  ## Points                        │  ☐ Fix export         │
│ • Daily note  │  - Quote signed                   │ DONE 2                │
│               │  📎 quote.pdf                     │  ☑ Tidy inbox         │
└───────────────┴───────────────────────────────────┴───────────────────────┘
```

## Install (Linux)

Download the latest release from
[GitHub Releases](https://github.com/timotheegrollier/work-logs/releases)
(English release notes on every version) and verify it:

| File | For |
|---|---|
| `WorkLogs-*-linux-amd64.deb` | Ubuntu 24.04, Linux Mint 22.x and other Debian-based distros |
| `WorkLogs-*-linux-x86_64.rpm` | Fedora 43 / 44 and other RPM-based distros |
| `WorkLogs-*-linux-x86_64.AppImage` | Any 64-bit distro, no install needed |

```bash
sha256sum -c SHA256SUMS
```

### One-click updates

Once the repository is enabled, the app installs later versions on its own, after
your confirmation and password.

```bash
# Debian, Ubuntu, Linux Mint
sudo curl -fsSL -o /etc/apt/sources.list.d/worklogs.list \
  https://timotheegrollier.github.io/work-logs/deb/worklogs.list

# Fedora and other RPM distros
sudo curl -fsSL -o /etc/yum.repos.d/worklogs.repo \
  https://timotheegrollier.github.io/work-logs/rpm/worklogs.repo
```

The AppImage updates itself, differentially — nothing to enable.

Data lives in `~/.local/share/worklogs/`, profile and theme in
`~/.config/worklogs/`. The app checks for updates on launch and offers the
download in one click (see `docs/07-RELEASES.md` for how releases are built).

## Develop

```bash
cd /home/timo/dev/work-logs
npm run install:all     # once
npm run dev             # API :8410 + web :8411 → http://localhost:8411
```

Single process (the server also serves the front): `npm start` → http://localhost:8410.
Desktop app: `npm run desktop`.

## Use

| Gesture | Effect |
|---|---|
| **+ New entry** | creates today's entry and focuses the title |
| **+ New document** | rich editor: styles, lists, links, tables and local images |
| Write in the Markdown area | **autosaves**, `Ctrl+S` to force |
| **Write / Read** | side-by-side editing with preview, or full-width reading |
| **Print** (or `Ctrl+P`) | prints the entry alone, clean layout, PDF-ready |
| 📎 **Attach a file** | attaches a document to the open entry |
| 👁 **Preview** | reads the file inside WorkLogs (image, PDF, text) without downloading it |
| Type + `Enter` in “New task” | adds a task to the Todo column |
| Check a card · drag it | finishes it · moves it across columns |
| Click a project | filters **journal and tasks** at the same time |
| **Search** | searches entry titles, bodies and tasks |
| **Create linked task** in an entry | creates a task with that entry as context |
| **Export** | downloads the whole database as JSON |

Supported Markdown: headings, bold/italic, lists, **check boxes**, **tables**,
quotes, code blocks, links, images.

Rich documents autosave locally and retain formatting in JSON exports. In the desktop
app, expand **Google Drive**, import your Google Cloud desktop OAuth client JSON, then
connect and authorize documents. Editing happens inside WorkLogs; Google sign-in and
file authorization use the system browser. **Save to Drive** sends changes explicitly.
Initial Drive support covers text, headings, basic styles and flat lists; complex Google
documents are rejected before import/write. Tables and images work locally. OAuth/API
tests use simulated responses; a real-account round trip remains to be verified.

The **WorkLogs backups** section in the Google Drive dialog stores a versioned JSON file in Drive and restores it on another WorkLogs installation connected to the same account. Restore replaces local data after confirmation; local attachment bytes are not part of this JSON.
[Setup, limitations and implementation](docs/08-GOOGLE-DOCS.md).

## Test

```bash
npm test            # API (node:test) + front (vitest)
npm run test:e2e    # real browser journeys (playwright)
./scripts/check.sh  # everything: types + tests + build + browser + desktop
```

## Back up

```bash
./scripts/backup.sh     # → ~/WorkLogs-backups/worklogs-AAAAMMJJ-HHMMSS/
```

## Documentation

Most docs are in French (the author's language); release notes and this file
are in English. French version of this file: [`README.fr.md`](README.fr.md).

| Doc | For | Content |
|---|---|---|
| `docs/00-HANDOVER.md` | **everyone, first** | project state, 3-command pickup, checklist |
| `docs/01-ARCHITECTURE.md` | dev / agent | DB schema, API reference, front structure |
| `docs/02-DEV.md` | dev / agent | setup, tests, conventions, pitfalls |
| `docs/03-UTILISATION.md` | Timo | the screen, Markdown, printing, backups |
| `docs/04-RECETTES.md` | dev / agent | “how to do X”: add a field, migrate, debug, ship |
| `docs/05-DECISIONS.md` | dev / agent | **why** things are the way they are, and what was removed on purpose |
| `docs/06-DESKTOP-CICD.md` | dev / agent | Linux desktop record: bugs found, packaging, CI |
| `docs/07-RELEASES.md` | dev / agent | **release process**: versioning, fast path, notes, checklist |
| `AGENTS.md` · `CLAUDE.md` | agents | the rules, on one page |

Data: `api/data/worklogs.db` (SQLite) and `api/data/uploads/` — never committed.
