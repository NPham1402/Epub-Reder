# devdocs — EPUB reader disguised as code documentation

A private EPUB reader that runs entirely on **Cloudflare Workers**, storing metadata
in **D1** and book content in **R2**. The UI is a VS Code–style "documentation
viewer": chapters look like source files, prose is rendered as Markdown docs with a
line-number gutter, and a **focus key (`Esc`)** instantly swaps the whole screen for a
believable build log + source file. A quick glance reads as "someone reading code docs".

## How the disguise works

| Real thing            | Shown as                                             |
| --------------------- | ---------------------------------------------------- |
| A book                | A "module" / folder in the Explorer (`auth-gateway`) |
| A chapter             | A source file (`0007_edge_session.ts`)               |
| Paragraphs            | Markdown documentation lines (optional `//` camo)    |
| Reading position      | Editor scroll + `Ln x, Col 1` in the status bar      |
| Panic / someone walks | `Esc` → full-screen fake `build.log` + code          |
| Alt-tab away          | Auto focus-mode (toggleable in Preferences)          |

## Architecture

```
Browser (public/) ──► Worker (Hono, src/index.ts) ──► D1  (books, chapters, progress)
                                              └──────► R2  (raw .epub + parsed chapter JSON)
```

- **Upload**: EPUB is unzipped in the Worker (`fflate`), the OPF/spine/TOC parsed
  (`fast-xml-parser`), and each chapter's XHTML flattened to heading/paragraph blocks
  (`htmlparser2`). Raw file → R2; parsed blocks → R2 JSON; metadata → D1.
- **Read**: the frontend pulls chapter JSON and renders it as documentation.
- **Auth**: a single access passcode → HMAC-signed httpOnly session cookie.

## One-time setup

Requires Node 18+ and a Cloudflare account.

```bash
npm install
npx wrangler login
```

### 1. Create the R2 bucket

```bash
npx wrangler r2 bucket create epub-reader-books
```

### 2. Create the D1 database and apply migrations

```bash
npx wrangler d1 create epub_reader_db
```

Copy the printed `database_id` into `wrangler.jsonc` (replace
`REPLACE_WITH_YOUR_D1_DATABASE_ID`), then:

```bash
npm run db:migrate          # remote (production)
```

### 3. Set the secrets

```bash
npx wrangler secret put ACCESS_PASSCODE     # the passcode you'll type to unlock
npx wrangler secret put SESSION_SECRET      # a long random string
```

### 4. Deploy

```bash
npm run deploy
```

Open the printed `*.workers.dev` URL, enter your passcode, then click **+** (top
right) or press `Ctrl+Shift+U` to import an `.epub`.

## Automated deploy (GitHub Actions)

`.github/workflows/deploy.yml` deploys on every push to `main`/`master` (and via
manual "Run workflow"). It runs `scripts/deploy.sh`, which is **idempotent** and does
everything with your Cloudflare token — no manual resource setup needed:

1. Creates the R2 bucket `epub-reader-books` if missing.
2. Creates the D1 database `epub_reader_db` if missing, reads its id, and injects it
   into `wrangler.jsonc` at build time (leave the `REPLACE_WITH_YOUR_D1_DATABASE_ID`
   placeholder in the committed file — CI fills it, don't commit a real id).
3. Applies D1 migrations (`--remote`).
4. Deploys the Worker.
5. Sets the `ACCESS_PASSCODE` / `SESSION_SECRET` Worker secrets.

### Required GitHub repository secrets

Settings → Secrets and variables → Actions → New repository secret:

| Secret                  | Value                                                     |
| ----------------------- | -------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare API token (see scopes below)                  |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account id                               |
| `ACCESS_PASSCODE`       | Passcode you'll type to unlock the reader                |
| `SESSION_SECRET`        | A long random string (e.g. `openssl rand -hex 32`)       |

Or with the GitHub CLI:

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
gh secret set ACCESS_PASSCODE
gh secret set SESSION_SECRET
```

### Cloudflare token scopes

A full-access token works. For least privilege, create a **Custom token** with:

- Account · **Workers Scripts** · Edit  *(also lets it manage Worker secrets)*
- Account · **Workers R2 Storage** · Edit
- Account · **D1** · Edit
- Account · **Account Settings** · Read  *(to resolve the account id)*

No Zone permissions are needed for a `*.workers.dev` deployment.

## Local development

```bash
cp .dev.vars.example .dev.vars      # set ACCESS_PASSCODE + SESSION_SECRET
npm run db:migrate:local            # create local D1 tables
npm run dev
```

`wrangler dev` provides local simulated D1 + R2, so you can test uploads offline.

## Keyboard shortcuts

| Shortcut               | Action                          |
| ---------------------- | ------------------------------- |
| `Esc`                  | Toggle focus mode (boss key)    |
| `Ctrl/Cmd + B`         | Toggle sidebar                  |
| `Ctrl/Cmd + Shift + U` | Import `.epub`                  |
| `Ctrl/Cmd + =` / `-`   | Font size                       |
| `Alt + ← / →`          | Previous / next chapter         |

## Notes & limits

- Images inside EPUBs are stripped (text-only) — this keeps the "docs" disguise clean.
- Upload size guard is 60 MB; Workers request-body limits apply on the free plan.
- Content is private to whoever has the passcode; there is no multi-user separation.
- For a stronger gate you can also put the Worker behind **Cloudflare Access**.

## Project layout

```
src/
  index.ts   Hono router: auth, upload, chapters, progress
  epub.ts    EPUB unzip + OPF/spine/TOC + XHTML → blocks
  auth.ts    HMAC session cookie + passcode compare
  names.ts   Deterministic fake file/module names
  types.ts   Shared types + Env bindings
public/
  index.html VS Code–style shell
  styles.css Theme
  app.js     Reader logic, tree, progress, boss key
migrations/
  0001_init.sql
```
