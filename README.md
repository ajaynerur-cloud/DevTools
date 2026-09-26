# DevHub

A developer toolkit for phone, tablet and desktop, with private user accounts:

- **Tasks:** a full task tracker with Today, Upcoming, Board, All tasks and Insights views.
- **30 developer tools:** formatters, large-file converters, encoders and generators. They run entirely in the browser and need no account.
- **Tool store links:** your own list of registries and marketplaces.
- **Accounts:** registration and sign-in, where every user sees only their own data.

It's installable as a PWA, and an Android APK is built by GitHub Actions.

## How it fits together

```
Browser / Android app ──HTTPS──▶ server.js on Render ──GitHub API──▶ private data repo
  (tools run locally,             (accounts, sessions,                devhub/users/index.json
   tasks cached offline)           per-user access)                   devhub/users/<id>/tasks.json
                                                                      devhub/users/<id>/links.json
```

The GitHub token lives only on the server. Every data request carries a signed session token, and the server takes the user id from that token. So a user can never read or write another user's files, whatever the browser sends.

**Accounts:** passwords are stored as salted scrypt hashes, never in plain text. Sign-in attempts are rate limited. Changing a password or choosing "Sign out on all devices" revokes existing sessions.

**Offline:** each user's data is cached on the device, so the app keeps working offline and syncs when it reconnects. If two devices edit at once, changes merge per task, and the most recent edit to each task wins. Signing out wipes that user's data from the device.

## Online or offline

Opening **Tasks** or **Tool stores** asks how you want to keep your data:

| | Online | Offline |
|---|---|---|
| Account | Sign in or register | None |
| Where data lives | Your private data repo, through the server | A **JSON** or **SQLite** file on your device |
| Sync between devices | Automatic | Move the file yourself (USB, cloud drive, email…) |
| Needs internet | To sync (edits work offline and sync later) | Never |

The developer tools never need either; they always work without signing in.

**Offline databases**
- **Create new database:** pick a name and a format.
  - **JSON** is readable text you can keep in Git.
  - **SQLite** is a real database you can query with DB Browser for SQLite, `sqlite3` or DBeaver. It has tables `tasks`, `projects`, `links`, `settings` and `meta`, plus an `open_tasks` view.
- **Open database file:** choose a `.json`, `.sqlite` or `.db` file from your computer, phone or tablet.
- **How saving works:**
  - **Chrome or Edge on a computer:** you pick where the file lives, and every change is saved into it automatically.
  - **Phones, tablets, Firefox, Safari and the Android app:** your database is kept in the browser while you work, so nothing is lost on reload. Press **Save file** to write a copy to Downloads or Files (in the Android app, it opens the share sheet). The status line shows whether the file is up to date.
- **The Database page** (bottom tab on phones, your name chip on desktop) shows file details. You can download the data as JSON or SQLite to convert between them, switch files, or close the database and sign in instead.

**Moving between modes**
- **Offline to online:** sign in, then use Account → Import backup with your `.json` or `.sqlite` file.
- **Online to offline:** use Account → Export JSON or Export SQLite, then use "Open database file" on any device.

## Task tracker

- **Quick add with smart parsing:** for example, `Fix login bug #backend @web !high tomorrow 45m every weekday`. This one line sets tags, a project, the priority, the due date, an estimate and a repeat rule.
- **Views:**
  - Today: overdue tasks (with "Move all to today"), today's tasks with planned time, and a collapsible "Completed today".
  - Upcoming: the next 14 days, "Later" and "No date".
  - Board: kanban columns. Drag and drop with a mouse; on touch, use the ← → buttons.
  - All tasks: filter by status and sort.
  - Insights: tasks done over 14 days, week-over-week change, on-time rate, focus time, streak, priority mix and project progress.
- **Task details:** status, priority (Urgent/High/Medium/Low), due date, project, repeat, estimate, tags, notes, subtasks and a start/stop timer. Only one timer runs at a time.
- **Recurring tasks:** completing one schedules the next occurrence.
- **Projects:** each has a colour, and you can create one inline with `@name`.
- **Header stats:** daily goal ring, streak, focus time today and overdue count.
- **Other:** undo after deleting, and keyboard shortcuts: `N` new task, `/` search, `1`–`5` switch view.

## Setup: two repositories

DevHub uses **two GitHub repositories**. All code goes in the first one, and the second one starts empty.

| | App repo | Data repo |
|---|---|---|
| Example name | `you/devhub` | `you/devhub-data` |
| Visibility | public or private | **private** (required) |
| What you upload | **every file from this project** | **nothing** — just tick "Add a README file" when creating it |
| Who writes to it | you (code changes) | the DevHub server, automatically |
| Used by | Render, GitHub Actions (APK, Pages) | the DevHub server (`server.js` on Render), through its token |

**App repo** (`you/devhub`), everything from the zip:

```
.github/workflows/android.yml   builds the Android APK
.github/workflows/pages.yml     optional GitHub Pages deploy
icons/  vendor/  seed/          icons, bundled libraries, default links
index.html  styles.css  config.js  app.js  tasks.js  worker.js  sw.js  manifest.webmanifest
server.js                       the server Render runs
render.yaml                     tells Render how to run it
package.json  capacitor.config.json   used by the APK build
.gitignore  .nojekyll  README.md
```

**Data repo** (`you/devhub-data`), created empty. The server fills it in as people register and add tasks:

```
README.md                       the only file you add (when creating the repo)
devhub/users/index.json         appears automatically: accounts with hashed passwords
devhub/users/<user-id>/tasks.json
devhub/users/<user-id>/links.json
```

The two repos never reference each other directly; Render links them through environment variables.

Don't put the GitHub token in any file or repo; it only goes into Render. Don't use one repo for both, because user data could become public.

### Step 1: Create the app repo and upload the code
1. On GitHub, create a new repository called `devhub`.
2. Unzip the project and upload everything from it:
   ```bash
   cd devhub
   git init && git add . && git commit -m "DevHub"
   git branch -M main
   git remote add origin https://github.com/<you>/devhub.git
   git push -u origin main
   ```

### Step 2: Create the data repo (empty, private)
1. On GitHub, create a new repository called `devhub-data`.
2. Choose **Private** and tick **Add a README file**, then click Create. Don't upload anything else.

### Step 3: Create a token that can write to the data repo
Go to GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token:
- **Repository access:** Only select repositories → `devhub-data`
- **Permissions:** Repository permissions → Contents → **Read and write**

Copy the token. You'll paste it into Render in the next step.

### Step 4: Deploy on Render (from the app repo)
1. In Render, choose **New → Blueprint**, connect GitHub, and pick the **app repo** (`devhub`). Render reads `render.yaml` from it.
2. Render asks for these environment variables:

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | the token from step 3 |
| `DATA_REPO` | `<you>/devhub-data` (the **data repo**) |
| `REGISTRATION` | `open` (anyone can sign up), `code` (needs an invite code), or `closed` |
| `REGISTRATION_CODE` | the invite code, if `REGISTRATION=code` |
| `CORS_ORIGINS` | leave empty unless you use GitHub Pages (step 6) |
| `SESSION_SECRET` | filled in automatically — leave it |

3. Click **Apply**. When the deploy finishes, open your `https://….onrender.com` URL and create the first account.
4. Check it worked: the data repo now contains `devhub/users/index.json`.

If the site is public, use `REGISTRATION=code` so strangers can't create accounts that write to your data repo.

On Render's free plan the service sleeps when idle, so the first request after a while takes a few seconds. The app keeps working from its offline copy meanwhile.

### Step 5: Android APK (optional, in the app repo)
1. In the **app repo**, go to Settings → Secrets and variables → Actions → **Variables**, and add `API_BASE_URL` = your Render URL.
2. Go to **Actions → Build Android APK → Run workflow**, then download the APK from the run's Artifacts.
3. Optional: tag a release with `git tag v3.0.0 && git push --tags` to publish the APK to a GitHub Release.
4. Optional: for a signed release APK, add the secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. Create the keystore with `keytool -genkey -v -keystore release.keystore -alias devhub -keyalg RSA -keysize 2048 -validity 10000`, then run `base64 -w0 release.keystore`.

### Step 6: GitHub Pages (optional, in the app repo)
Pages can host the front end only; accounts still go through Render.
1. Set the `API_BASE_URL` variable as in step 5.
2. On Render, set `CORS_ORIGINS=https://<you>.github.io`.
3. In the **app repo**, go to Settings → Pages → Source: **GitHub Actions**.

## Run locally

```bash
node server.js          # http://localhost:3000 — stores data in ./storage (no GitHub needed)
```

Node 22+, no `npm install` needed for the server. To use GitHub storage locally, set the same environment variables as on Render.

## Server configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port (Render sets this) |
| `GITHUB_TOKEN`, `DATA_REPO` | — | Enable GitHub storage. Without them, data goes to `STORAGE_DIR` |
| `DATA_BRANCH` / `DATA_DIR` | `main` / `devhub` | Branch and folder inside the data repo |
| `STORAGE_DIR` | `./storage` | Local storage (development only — Render's disk is wiped on deploy) |
| `SESSION_SECRET` | random | Signs sessions |
| `SESSION_DAYS` | `30` | How long a sign-in lasts |
| `REGISTRATION`, `REGISTRATION_CODE` | `open` | Who can create accounts |
| `CORS_ORIGINS` | — | Extra allowed web origins, comma-separated. The Android app is always allowed |

## API

All data routes require `Authorization: Bearer <token>`.

| Route | |
|---|---|
| `POST /api/auth/register` | `{name, username, email?, password, code?}` → `{token, user}` |
| `POST /api/auth/login` | `{login, password}` (username or email) → `{token, user}` |
| `GET /api/auth/me` · `POST /api/auth/profile` · `POST /api/auth/password` · `POST /api/auth/logout-all` · `DELETE /api/auth/account` | account management |
| `GET /api/data/{tasks,links,prefs}` | → `{data, version}` for the signed-in user |
| `PUT /api/data/{tasks,links,prefs}` | `{data, baseVersion}` → `{version}`, or `409` with the server copy if another device saved first |

## Limits worth knowing

- Every save is a commit to the data repo. The app batches edits (about 1 s), and the server caps each user at 240 saves an hour. GitHub allows 5,000 API calls an hour per token, which suits individuals and small teams. For large teams, swap the storage adapter in `server.js` for a database.
- There's no email-based password reset (the server doesn't send email). To reset a password, the admin can remove the user from `users/index.json` in the data repo so they can register again. Their data files stay in place.
