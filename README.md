# Toolbox+

*Formerly DevHub.* One app for the everyday: developer tools and converters, a task tracker, work links, tool stores and insurance policies with renewal reminders — in the browser, as a Windows portable exe and as an Android app, online (synced) or fully offline.

> Renamed from DevHub: the name, icon and texts changed everywhere. Things that identify existing data were kept on purpose, so nothing is lost when you update: the Render service name and URL (`devhub` in `render.yaml`), the Android app id `io.github.devhub`, the data folders (`devhub/` in the data repo, `Documents/DevHub/` on Android), browser storage keys and the `app: "devhub"` marker inside database files.

For phone, tablet and desktop, with optional private user accounts:

- **Tasks:** a full task tracker with Today, Upcoming, Board, All tasks and Insights views.
- **35 developer tools:** formatters, large-file converters, a data migrator, a text → JSON/XML mapper, encoders and generators. They run entirely in the browser and need no account.
- **Tool store links:** your own list of registries and marketplaces.
- **Insurance:** your policies with documents and daily renewal reminders — offline only, on the device.
- **Links:** your everyday work links (intranet, boards, dashboards, timesheets…) with groups, pinning, search and one-click copy.
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

## Home

Toolbox+ opens on **Home**:

- **Search** everything on the device — tools, your Links and your insurance policies (Enter opens the first result).
- **Overview cards:** Tasks (due today / overdue), Insurance (next renewal), Links (saved / pinned) and Sync (signed in or this device only). Each opens its page.
- **Pinned links** as one-click chips, and your **recently used** tools.
- **All tools** grouped (Formatters, Converters, SAP tools, …) in collapsible cards with **Expand all / Collapse all**; your choice is remembered. Phones start with the groups collapsed.
- **More:** Tool stores (on phones it's here instead of the bottom bar), Tasks board & insights, Account / sign in.

Home reads only what is already on the device and never contacts the server.

On the **Tools** page the tool list has **Collapse all / Expand all** and **« Hide** (more room for the tool; **☰ Tools** brings the list back). Both are remembered.

## Compact views

**Links**, **Insurance**, **Tool stores** and Home's **All tools** have a view switch (≡ **1 line** · **2 lines** · ▦ **Expanded**), remembered per page:

- **1 line:** one row per item — name plus the key detail (address for links; insurer, policy no. and next date for policies).
- **2 lines:** adds a second line (for policies: holder, premium and the next alert or snooze).
- **Expanded:** the full cards.

In the compact Insurance views every row has **⤓** to download the policy document straight away (with several documents, a small menu lets you pick one or *Download all*), and **⋯** with Edit, Mark renewed, Snooze, Add to calendar and Delete. Tap a policy's name to edit it.

## Sync asks for you

Every sync you start (Links **⇅ Sync now**, **↓ Pull / ↑ Push** in the sidebar or Account) checks first:

- **Not signed in:** a *Sign in to sync* box opens right there (sign-in is never required to use Toolbox+ — only to sync).
- **Signed in, Android app:** your **fingerprint** (or the phone's screen lock) is asked, then remembered for 5 minutes.
- **Signed in, computer:** syncs straight away.

Automatic sync only runs for a signed-in account and doesn't prompt in the background.

## Links (everyday work links) — offline first, sync optional

The **Links** menu (below Tool stores) keeps the links you open every day. It works **without signing in**: links are saved on the device (browser storage / Android app / portable exe) and never sent anywhere unless you choose to sync.

- **Paste and press Enter** to add a link; it's named from the address (press Edit to rename it). *Add with details…* sets the name, group, notes and pin.
- **Pin** (☆/★) keeps a link in the *Pinned* section at the top. Other links are listed by group; search covers name, address, group and notes. **Copy** puts the address on the clipboard; Delete can be undone.
- **Move from Tool stores:** *Move to Links* on a link, or *Move all to Links →* on a category, moves it here (the category becomes its group) and removes it from Tool stores. Undo is offered right after.
- **Sync (optional, signed-in users):** the bar at the top shows *Sync with ⟨you⟩'s account* with
  - **Manual** (default): nothing is sent until you press **⇅ Sync now**;
  - **Automatic · every 5 min**: syncs every 5 minutes while Toolbox+ is open, when you come back to it, and when you leave it with unsynced changes.
  Sync is two-way: links added or edited on any device are merged per link (newest edit wins) and deletions sync too. It's stored in the account as `worklinks.json`, separate from tasks and tool stores, and is independent of the account's own Pull / Push setting.
- **Export / Import** a JSON file of your links (also the way to move them without an account). **Clear device** removes the links stored on this device (the account copy stays).
- Links that older versions kept inside the account or offline database are moved to the device automatically the first time you open Links.

## Sync with the server (signed-in users only)

The server on Render is contacted **only when you are signed in**. The developer tools, the sign-in screen until you press *Sign in*, the portable Windows build and offline databases never contact it. Every edit is saved on the device first.

Choose the mode in **Account → Sync and data** (remembered per device):

| | Automatic (default) | Manual |
|---|---|---|
| Pull (get the latest from the account) | when you open Toolbox+, then every 5 minutes while it's open, and when you come back to it after 5 minutes or more | only when you press **↓ Pull** |
| Push (send this device's changes) | at the next 5-minute sync, and when you leave the page | only when you press **↑ Push** |

**↓ Pull** and **↑ Push** are always available: under your name in the sidebar, in the status line on phones, and on the Account page. Signing in fetches your data once in both modes.

**No wake-up screen.** A free Render instance sleeps when idle and shows its own "starting up" page to a browser that opens it. Toolbox+ never shows it:
- sync requests ask for JSON, and if the host answers with an HTML page instead Toolbox+ waits quietly and retries; the status line only ever says *Syncing…*, *Synced 10:32* or *Saved on this device*;
- when the app itself is served from Render, the service worker opens the copy stored on the device if the server takes more than 3 seconds or returns anything that isn't Toolbox+, and stores the new version in the background. (Only the very first visit on a device has nothing stored yet.)
- For desktop use, the **GitHub Pages** address (Render used only for sync) or **ToolboxPlus-Portable.exe** (no server at all) avoid Render for opening the app entirely. For Pages, set the repository variable `API_BASE_URL` to your Render URL and Render's `CORS_ORIGINS` to your Pages origin.

## Insurance (offline, on this device)

The **Insurance** menu keeps your insurance policies and reminds you before they renew. It needs no account and never contacts the server: policies and attachments are stored on the device in IndexedDB (the browser is asked to keep them persistently) and are not part of account sync or backups. Use **Export** / **Import** on the page to move them (one JSON file including the documents).

- **Policy:** name, type, insured / holder name, insurer, policy number, **policy date**, **next date** (renewal / due), premium, notes.
- **Attachments:** any number of documents per policy (PDF, photos, Office files…, up to 40 MB each), chosen with the system file picker or dropped on the dialog. Tap one to open it (Android: the share sheet opens it in a viewer or saves it).
- **Reminders, per policy (Edit → Reminders):** every policy has its own dates and its own schedule and notifications; *Next reminders* at the top of the page lists the next alert of each policy.
  - **Start reminding:** a number of days before the next date (default 30) *or* from a chosen date, and the **time**.
  - **Repeat on:** every day, every week (counting back from the next date), or only on chosen days before it (e.g. `30,15,7,3,1,0`).
  - **Each of those days:** once, twice (the time and 9 hours later), every 4 hours or every hour until 22:00.
  - **After the next date:** keep reminding every day until you press **Mark renewed…** (on by default).
  - The dialog previews the first alert and how many alerts you'll get; each card shows the rule and the next alert.
- **Snooze:** every reminder in the Android notification bar has **Snooze 15 min**, **Snooze 1 hour** and **Tomorrow**. They work in the background — the notification goes away, a short "Snoozed until …" message appears, and the reminder comes back in the notification bar at that time; Toolbox+ isn't opened. Desktop Chrome/Edge show *Snooze 1 hour* and *Tomorrow*. The policy card has **Snooze…** (15 min, 1 h, 3 h, tomorrow, 3 days, 1 week) and **Resume now**; snoozes made in the notification bar show there the next time Toolbox+ opens.
  - **Android: battery & background permissions.** After notifications and *Alarms & reminders* are allowed, Toolbox+ shows a **Keep reminders working** checklist with a button for each item and a live ✓ when it's done: **Battery: Unrestricted** (Android's *Let app always run in background?* dialog), **Background usage** (App info), and on Xiaomi / Redmi / POCO, Oppo / Realme / OnePlus, Vivo / iQOO, Huawei / Honor, Samsung, Asus, Tecno / Infinix, Nokia the maker's **Auto-start** screen (ticked off by you, as Android can't report it). It comes back on every start (at most once a day after *Later*) until everything is done, and can be opened any time from Insurance → Reminders… or the Notifications dialog. On OnePlus / Oppo / Realme the auto-start item opens App info, where **Battery usage** has *Allow auto launch* and *Allow background activity*.
  - **Native reminder engine (`android-src/`):** `Reminders.java` schedules each insurance reminder as an exact alarm (allowed in Doze), `ReminderReceiver.java` shows it with the Snooze buttons and handles them without opening the app, `BootReceiver.java` sets the alarms again after a restart or update, `DevHubPower.java` is the plugin the web app talks to (permissions, `setReminders`, `takeState`, `showNow`) and `MainActivity.java` registers it. The Android workflow copies these into the app, adds the receivers to the manifest and `android-res/drawable/ic_stat_reminder.xml` as the status-bar icon. **Reminders… → Test now** shows a real reminder with the Snooze buttons.
  - **Android app:** reminders are scheduled with the Android alarm manager as exact alarms allowed while idle, so they arrive when the app is closed or swiped away, in battery-saving mode and after a restart. The next 45 days are scheduled each time the app opens (up to 350 alerts). Pressing a Snooze button opens Toolbox+ for a moment to reschedule. Only *Force stop* in Android settings cancels alarms (an Android rule); on Xiaomi, Oppo, Vivo and similar phones also allow **Autostart** for Toolbox+. The app asks for notifications on first start (required). The manifest declares `POST_NOTIFICATIONS`, `SCHEDULE_EXACT_ALARM`, `USE_EXACT_ALARM`, `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK` and `VIBRATE`; no storage permission is needed. For the most reliable alarms set *Settings → Apps → Toolbox+ → Battery → Unrestricted*.
  - **Browser / portable exe:** reminders appear while Toolbox+ is open (a tab or the installed app); a browser cannot wake a closed page. **Add to calendar** on a policy downloads an `.ics` with a daily reminder series (from N days before until the renewal date) for Outlook or Google Calendar.
- **Read policy PDFs (on the device, nothing is uploaded):**
  - **📄 Add from PDF** — pick the policy PDF; Toolbox+ reads it and opens *Add policy* already filled in: policy name (product/plan), type, insured / holder, insurer, policy number, policy (start) date, next date (the *next premium due date*, otherwise the expiry / end of the period of insurance) and premium (the total / gross premium). Filled fields are highlighted — check them and Save; the PDF is attached.
  - **Read details** next to any attached PDF in Edit fills the empty fields (or, if you agree, replaces different values).
  - The text of a read PDF is kept with the policy, so **Search policies** also finds words inside the document (e.g. a vehicle number or a sum insured).
  - Scanned PDFs / photos have no text to read — Toolbox+ says so and you fill in the details.
  - Works for common Indian and international policy schedules (Star Health, ICICI Lombard, HDFC ERGO / Life, LIC, Bajaj, Tata AIG/AIA, Niva Bupa, Care, New India, SBI and many more); unknown layouts still give the dates, policy number and premium in most cases.
- **View documents in the app:** tap a document (or ⋯ → *View document* in the compact views) to read the PDF pages or the photo inside Toolbox+, with zoom and Download — also offline and in the Android app. Uses the bundled [pdf.js](https://github.com/mozilla/pdf.js) (`vendor/pdf.min.js`, `vendor/pdf.worker.min.js`, `vendor/pdfjs-fonts/`, Apache-2.0).
- **Mark renewed…** moves the next date forward (default one year) and keeps a history.

## Online or offline

Opening **Tasks**, **Tool stores** or **Links** asks how you want to keep your data:

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
- **Open database file:** choose a `.json`, `.sqlite`, `.db` or `.xml` file from your computer, phone or tablet: a Toolbox+ database, or your own task file (see below).
- **How saving works:** there's always exactly one database, saved automatically. Toolbox+ never creates extra copies.

  | Where you use Toolbox+ | Where the database is saved |
  |---|---|
  | Chrome or Edge on a computer | The file you choose once. Every change is saved into that same file. |
  | Android app | `Documents/DevHub/<name>.sqlite` on the device, overwritten in place on every save |
  | Firefox, Safari, phone browsers | Inside the browser, because these browsers can't write into a file on your device. Use **Download backup** when you want a file, and keep one somewhere safe, because clearing the browser's data removes the database. |

- **The Database page** (bottom tab on phones, your name chip on desktop) shows file details. You can download the data as JSON or SQLite to convert between them, switch files, or close the database and sign in instead.

### Migrate an existing task file (offline)

"Open database file" also accepts a task list you already have: a `.db`/`.sqlite` from another app, a `.json` or an `.xml`.

1. **See what's inside.** Toolbox+ shows every table or list in the file with its rows, before anything is changed. Files saved as UTF-16 (PowerShell, Notepad) and JSON Lines are read too. If a file can't be read, Toolbox+ says exactly what it is: empty, encrypted SQLite, a Git LFS pointer, CSV, an Access or Python-shelve database, and so on.
2. **Map it.** Toolbox+ finds the table or list that holds your tasks and suggests which field is the title, status, priority, due date, project, notes and dates. For example, `description` becomes Notes and `due_date` becomes Due date. It also asks what your status and priority values mean, e.g. `Completed` = Done and `In Progress` = In progress. Fields Toolbox+ has no place for (e.g. `rag`, `reminder`) are kept and editable in each task.
3. **Migrate and save.** Your tasks are copied into **one** new Toolbox+ database (SQLite or JSON). The original file is never changed or locked, and the mapping is remembered for next time.
4. **From then on, there's one database.** Toolbox+ saves automatically into the same place every time and never creates copies.

**Moving between modes**
- **Offline to online:** sign in, then use Account → Import backup with your `.json` or `.sqlite` file.
- **Online to offline:** use Account → Export JSON or Export SQLite, then use "Open database file" on any device.

## SAP tools › SAP CVA Orchestrator

Tools → SAP tools → **SAP CVA Orchestrator** is the browser version of `SAP_CVA_Orchestrator_v2.pyw`. It runs entirely on the device, in a background worker.

1. **Applications:** open your `applications.json` (same format as the desktop tool) every time you use the tool; the applications show as a table where you can add or remove entries. *Save* writes the changes back into the same file in Chrome/Edge (other browsers download an updated copy). For security nothing is remembered: the applications, the file and the output folder are not stored on the device, and anything stored by earlier versions is removed.
2. **Source files:** up to 11 CVA findings workbooks, one row each, with worksheet, Application ID and scan date.
3. **Outputs:** one `<System>_<SystemNo>_<AppId>_CVA_Report.xlsx` per file, with a **Summary** sheet (P1/P2 findings and unique objects by remediation category, as live COUNTIFS formulas), a **Summary_By_Code_Objects** sheet (per CVA code: number of findings and unique objects), a **Summary_By_Code_ObjectList** sheet (per CVA code, the object names that have it with their finding counts), an **Object_Scorecard** sheet (one row per object, worst first: package, highest priority, P1–P4 counts, total, and a code breakdown such as `11D1 (137), 11G0 (12)`), a **Summary_By_Object_Code** sheet (findings per object and CVA code), then the same 13 sheets as the desktop tool. P1_P2_Backlog gets CVA Category and Remediation Timeline columns in front. Optionally, the `SAP_CVA_Executive_Summary.xlsx` (Consolidated_View) and the trend history `SAP_CVA_History.json`. Open last run's history and tick *Subsequent run* to append.
4. **Re-run / Clear all:** *Re-run* clears the results and log and processes the same files again (the history is not appended twice). *Clear all* removes the source files, created files and log; applications, settings and the output folder stay. Files already saved to the output folder are not deleted.
5. **Output folder** (Chrome/Edge on a computer): choose it in Outputs each visit; it is not remembered, and every run in that visit saves its reports straight into it. Other browsers save to Downloads. Each file can also be downloaded on its own, or all of them as a .zip.

Mapping is identical to the desktop tool: an exact CVA code in any text column wins, otherwise the best keyword/description score (≥ 20). The engine is `sap-cva-core.js`; styled Excel output uses `vendor/xlsx-style.min.js` ([xlsx-js-style](https://github.com/gitbrent/xlsx-js-style), Apache-2.0).

## SAP tools › SAP Scope Delta

Tools → SAP tools → **SAP Scope Delta** compares two ATC / CVA result workbooks per system and shows how much extra work the second one adds. It runs entirely on the device and works with the CVA Orchestrator's `Mapped_Data` sheet or any workbook that has object name, object type and priority columns.

1. **Comparisons:** add one row per system (A vs B, A1 vs B1 …). **A** is the baseline (e.g. RISE) and **B** is the one compared against it (e.g. CVA). Drop or choose a workbook on each side. The sheet and the Object name, Object type, Priority, Check message, Check title and Package columns are detected; change them under *Columns* if a file uses other names.
2. **Settings:** choose which priorities count (default P1 and P2), words that exclude a finding (default `syntax error`), an assumed false-positive rate for B (default 30%) and whether objects match on name + type or name only.
3. **Compare:** press **Compare** to calculate. Changing a file, sheet or column keeps the previous result on screen, marked as out of date, until you press Compare again.
4. **Results:** per system and in total: objects in A, in B, common, additional (B only), additional as a percentage of A, the same after the false-positive rate, and objects only in A. Each system also shows the common objects by priority (A priority against B priority) and the additional objects by type and priority, and notes how many additional objects exist in A only at a priority outside your scope.
5. **Export to Excel:** `SAP_Scope_Delta.xlsx` with a Summary sheet and, per system, a priority-matrix sheet and a full object list (common, additional, only in A) with priorities, finding counts and package.

Objects are counted once, at their highest priority. The module is `sap-delta.js` and uses `vendor/xlsx-style.min.js`.

## SAP tools › Remediation Project Planner

Tools → SAP tools → **Remediation Project Planner** estimates the effort, team size and timeline of an SAP remediation project from the findings per area. Enter object counts, rates and assumptions, read the live totals, results table and timeline, and export the plan to **Excel** or **PowerPoint**. It runs entirely on the device and keeps its plans in this browser (use *Open in a full window* for more room). The page is `remediation-planner.html` with its script in `remediation-planner.js` (the server's security policy only allows scripts from its own files, and lets only this one page be shown inside Toolbox+); its Excel and PowerPoint exports use the bundled `vendor/exceljs.min.js` and `vendor/pptxgen.bundle.js` (both MIT), so they work offline.

## Run on Windows without installing anything

`ToolboxPlus-Portable.exe` is a single file: copy it anywhere (a USB stick or a shared drive) and double-click it. It needs no installer, no administrator rights and no server. It opens Toolbox+ in an Edge or Chrome app window, with all 35 tools and the Tasks tracker in offline mode.

- The exe carries `ToolboxPlus.html` inside itself and writes it to `%LocalAppData%\ToolboxPlus-Portable`. Nothing else on the computer is changed. Delete that folder and the exe to remove it.
- Everything runs on the computer. Online accounts and sync need the Toolbox+ server, so they are not part of the portable build; use the offline database instead.
- `ToolboxPlus.html` also works on its own: open it in Chrome or Edge by double-clicking.
- Windows SmartScreen or a company policy may warn about an unsigned program. Have it signed by your IT team if your policy requires that.

Build both files when you need them:

- **On GitHub (nothing to install):** Actions → *Windows portable exe* → *Run workflow*. Download `ToolboxPlus-Portable.exe`, `ToolboxPlus.html` and `SHA256SUMS.txt` from the run's Artifacts. Pushing a tag such as `portable-v1.0` also attaches them to a release.
- **On Windows:** install Python 3 and Go 1.21+, then run `portable\build-windows-exe.bat`.
- **On Linux or macOS:** `sh portable/build-windows-exe.sh`. `python3 portable/build-single-file.py` creates only the HTML.

Both write to `dist/` (git-ignored).

## Text → JSON / XML mapper

Tools → Converters → **Text → JSON / XML mapper** turns a plain-text file into JSON or XML, with a mapping screen in between.

1. **Text:** upload a `.txt`, `.log`, `.csv`, `.dat`, `.prn`… file (UTF-8, UTF-16 and Windows-1252 are read), or paste text.
2. **Read the text:** Toolbox+ detects the layout and shows the records it found. Change it if needed:
   - **Columns with a delimiter:** comma, tab, pipe, semicolon, spaces or your own; quoted values are respected.
   - **Key: value lines:** `name: Ada` / `id=7` blocks, one block per record (a blank line or a repeated key starts the next).
   - **Fixed-width columns:** column start positions, detected automatically.
   - **Pattern:** a regular expression with named groups, e.g. `(?<date>\S+) (?<level>\w+) (?<message>.*)` for log lines.
   - **One value per line.**
   You can also skip header lines, ignore comment lines and trim spaces.
3. **Map fields:** for each field choose whether to use it, its target name, its type (text, number, whole number, true/false, date DD/MM/YYYY or MM/DD/YYYY → ISO, list split on `;` `,` `|`, JSON) and whether it becomes an XML element, attribute or text. Dots nest: `customer.address.city`. Add fixed values, reorder, or rename everything to camelCase / snake_case / PascalCase. The mapping is remembered for files with the same layout.
4. **Preview and create:** JSON and XML previews update live, with warnings for values that don't fit their type, duplicate names and invalid XML names. Choose the JSON shape (array, wrapped list, keyed by a field, JSON Lines), XML root/record element names, grouping and how to treat empty values, then **Create JSON** or **Create XML**.

## Data migrator (DB / JSON / XML)

Tools → Converters → **Data migrator** moves records from one file into another file you already have. Any combination works:

| Source ↓ / Target → | `.db` / `.sqlite` | `.json` | `.xml` |
|---|---|---|---|
| `.db` / `.sqlite` | ✓ | ✓ | ✓ |
| `.json` | ✓ | ✓ | ✓ |
| `.xml` | ✓ | ✓ | ✓ |

1. **Source:** the file with the data to move. Every SQLite table, and every list of records in JSON/XML (e.g. `users`, `catalog › book`), is found automatically.
2. **Target:** your existing file. Or start an empty SQLite, JSON or XML target.
3. **Map:** for each source table/collection, pick the target table/collection (or create a new one), and how to merge:
   - **Update matching records, add the rest** (upsert, matched on a key such as `id` ↔ `@id`)
   - **Add only records that aren't there yet**
   - **Add every record**
   - **Replace everything in the target collection**

   Fields are matched by name and common synonyms (`created_at` = `createdAt`, `description` → `notes`, `due_date` → `due`, `@id` = `id`). Any field can be mapped by hand, given a custom name, added as new, or skipped.
4. **Map values:** fields with up to 40 distinct values get a value editor, e.g. `Completed` → Done, `In Progress` → In progress, `Medium` → 3. Values are matched automatically when the target has fixed choices or existing values, and anything the target won't accept is flagged in red. Each card shows a sample of records after mapping.
5. **Preview migration** does a dry run: counts, notes and the first 20 records exactly as they'll be written. Nothing is created until you press **Create**.
6. **Download** the updated target (same file name). **Use as target** lets you merge another source into the result.

**Toolbox+ databases as targets.** When the target is a Toolbox+ database (JSON or SQLite, even an empty one), the migrator knows Toolbox+'s task fields and allowed values: status `todo/doing/done` and priority `1–4`. Project names become Toolbox+ projects (created and linked by id), dates are converted to ISO, `completedAt` is filled in for done tasks, tags become lists, and missing defaults are added. The result opens with Tasks → Open database file, with statuses intact.

What's kept: in SQLite targets, the other tables, views, indexes, triggers, defaults and constraints are untouched (new columns are added with `ALTER TABLE`); only the mapped columns of matching rows are updated. In JSON targets, everything outside the migrated arrays is kept, and so is the indentation. Values are converted to the target's types (e.g. SQLite `0/1` → JSON `true/false`, JSON text in a SQLite cell → real arrays/objects, XML text → numbers). Leading zeros in XML (`01234`) are kept. Rows that break a constraint are skipped and listed in the report; nothing else is lost. XML targets are re-indented, and their comments aren't kept.

Everything runs in the browser's background worker (`migrate.js` + the bundled sql.js), so no data is uploaded.

## Online copy of an offline database

On the offline **Database** page, **Online copy** keeps a copy of your offline database (JSON or SQLite) in a Toolbox+ account for safe keeping. You stay offline, and your file is still the database you work in.

- **Sign in… / Create account…** right on the page. This doesn't close your database or switch to online mode.
- If the account already has tasks, you choose to **add** this database's tasks (nothing in the account is removed) or **replace** the account's tasks.
- The copy is **updated automatically** about a minute after changes (the server allows a limited number of saves per hour), or immediately with **Update now**. Tasks are merged by their newest edit: the account keeps anything else it has, and deleting a task offline deletes it in the copy too.
- **Stop online copy** stops the updates; the last copy stays in the account. Sign in on any device to see it.

## Backup & import (signed-in accounts)

In the Tasks view (or Account → Backup & import):

- **Download backup:** a SQLite or JSON copy of your tasks, projects and links. It's also an offline database, so you can open it with "Use offline" on any device.
- **Keep one backup file up to date automatically:** on Chrome/Edge, pick a file once. In the Android app, the file is `Documents/DevHub/devhub-<you>-backup.sqlite`. The same file is rewritten after every sync; it's never a new copy.
- **Import tasks from a file:** a Toolbox+ backup, or any `.db` / `.json` / `.xml` task file. For other files, you see the contents and the field mapping first, as with offline migration. Then choose one of:
  - **Add to my tasks:** keeps what you have. Tasks in both keep their newest edit, and importing the same file again updates the tasks instead of duplicating them.
  - **Replace my tasks:** your current tasks are downloaded as a backup first.

## Task tracker

- **Quick add with smart parsing:** for example, `Fix login bug #backend @web !high tomorrow 45m every weekday`. This one line sets tags, a project, the priority, the due date, an estimate and a repeat rule.
- **Views:**
  - Week (default): a strip of the seven days with a dot for open tasks (red when a past day still has some, green when everything is done). Tap a day to see its tasks, a progress bar and planned time; use the arrows to change week and *Today* to jump back. On today you also get "Overdue" (with "Move all to today"), a collapsed "Completed" list and "No date" for tasks without a date. New tasks go to the selected day.
  - Board: kanban columns. Drag and drop with a mouse; on touch, use the ← → buttons.
  - All: filter by status and sort.
  - Insights: tasks done over 14 days, week-over-week change, on-time rate, focus time, streak, priority mix and project progress.
- **Task details:** status (To do, In progress, In review, Blocked, On hold, Done), due date, reminder and priority up front; project, repeat, estimate and tags under *More details*; then notes, subtasks and a start/stop timer. Only one timer runs at a time. On phones the editor opens as a bottom sheet.
- **Quiet task rows:** a title and one line of detail (due date when it isn't implied by the list, status, reminder time, project). Only urgent and high priority show colour. Search, filters, Projects, Reminders and Backup sit behind small buttons.
- **Recurring tasks:** completing one schedules the next occurrence.
- **Projects:** each has a colour, and you can create one inline with `@name`.
- **Header:** a one-line summary with your daily goal (tap to change it), streak and overdue count.
- **Other:** undo after deleting, and keyboard shortcuts: `N` new task, `/` search, `1`–`4` switch view.

## Notifications and reminders

Open **Reminders** in the task view (or set **Remind me** on a task) to get notifications on desktop and Android.

- **Task reminders:** pick a date and time under *Remind me* in a task. Repeating tasks move their reminder with the due date.
- **Daily summary:** tasks due today and overdue ones, at a time you choose (default 09:00).
- **Desktop and browsers:** Toolbox+ asks for permission when you click *Turn on* (or when you first set a reminder). Reminders fire while Toolbox+ is open in a tab or installed as an app; a browser cannot wake a closed page. If you blocked notifications, click the lock icon beside the address bar and set Notifications to Allow. On iPhone/iPad, add Toolbox+ to the Home Screen first.
- **Android app:** reminders are scheduled with Android's alarm manager, so they arrive with the app closed and after a reboot. The app **requires** the notification permission (Android 13+) and *Alarms & reminders* (Android 12+): a blocking screen stays up until both are on. The CI workflow declares these permissions in the manifest.
- Notification settings are per device and are not synced. The reminder time itself is stored on the task and syncs.

## How local and online tasks combine

Tasks are never replaced wholesale. Whenever a copy on this device meets the copy on the server (a sync, signing in, or the online copy of an offline database), both sets are added together: tasks that exist on only one side are kept.

**Field versions.** Every task carries `v` (a version number that goes up with each saved change), `fv` (when each field last changed) and `hist` (the last 20 changes: which fields changed, from what, to what). If the same task was edited on two devices, the merge works field by field: the newer change to each field wins, so a new due date from your phone and a new title from your laptop both survive. Older tasks without field versions fall back to newest-edit-wins. A deleted task stays deleted until you press Undo. Open a task and expand **History** to see its versions. Signing in or creating an account while an offline database is open adds that database's tasks, projects and links to the account.

## Online copy of an offline database: two-way

When an offline database has an online copy, the two are kept in step **both ways**. A sync fetches the account's tasks, adds any this database doesn't have, merges tasks changed on both sides field by field (see field versions above), and sends the combined result back, so the online board and the offline data end up identical. It runs when the app opens, when you return to it or come back online, every 5 minutes while it is open, after each save, and when you press **Sync now** on the Database page. Choosing *replace* when you first connect an account is the only way anything is overwritten.

## Fingerprint unlock (Android app)

Opt-in. After you sign in with your password the app offers *Unlock with your fingerprint?*; you can also switch it on or off under **Account → Fingerprint unlock**.

- **Remembered:** your sign-in token is stored in Android's hardware-backed Keystore, protected by your fingerprint, and is removed from the app's normal storage. It survives app restarts until you sign out, turn it off, or the session ends.
- **Opens from the phone first:** the lock screen needs no network. A fingerprint opens your tasks from the copy saved on the phone, and only then does the app contact the server: it pings the server to wake it (Render's free plan sleeps), shows "Waking the server…", then syncs. Unlocking never calls the login endpoint, and the app no longer calls the server just to start, so a sleeping server stays asleep until you are in.
- **Locks again:** after 1 minute away by default (choose immediately, 5 minutes, or only on restart). Nothing syncs while locked; reminders still fire.
- **Fallback:** if the fingerprint can't be used (fingerprints changed, new phone), the lock screen offers **Use password instead**. Signing out removes the Keystore copy.
- The phone needs a fingerprint enrolled in Android Settings. Face unlock also works where Android allows it.

## Setup: two repositories

Toolbox+ uses **two GitHub repositories**. All code goes in the first one, and the second one starts empty.

| | App repo | Data repo |
|---|---|---|
| Example name | `you/devhub` | `you/devhub-data` |
| Visibility | public or private | **private** (required) |
| What you upload | **every file from this project** | **nothing** — just tick "Add a README file" when creating it |
| Who writes to it | you (code changes) | the Toolbox+ server, automatically |
| Used by | Render, GitHub Actions (APK, Pages) | the Toolbox+ server (`server.js` on Render), through its token |

**App repo** (`you/devhub`), everything from the zip:

```
.github/workflows/android.yml   builds the Android APK
.github/workflows/pages.yml     optional GitHub Pages deploy
icons/  vendor/  seed/          icons, bundled libraries, default links
index.html  styles.css  config.js  offline-db.js  adapter.js  app.js  tasks.js  worker.js  migrate.js  sw.js  manifest.webmanifest
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
   git init && git add . && git commit -m "Toolbox+"
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

## Icons

Every icon comes from one design (a white `{ }` with a yellow bar on Toolbox+ blue):

| Where | Files |
|---|---|
| Browser tab | `favicon.ico`, `icons/icon.svg`, `icons/favicon-32.png` |
| iPhone/iPad home screen | `icons/apple-touch-icon.png` |
| Installed web app (PWA) | `icons/icon-192/512.png`, `icons/icon-maskable-192/512.png` (via `manifest.webmanifest`) |
| Android app icon | `android-res/mipmap-*/` (adaptive, legacy and round) |
| Android launch screen | `android-res/drawable*/splash.png`, plus a blue Android 12+ launch screen |

The APK workflow copies `android-res/` over Capacitor's defaults, so the app never shows the Capacitor logo.

To change the design or colours, edit `scripts/make-icons.py` and run:

```bash
pip install fonttools cairosvg && python3 scripts/make-icons.py
```

Then commit the updated `icons/`, `favicon.ico` and `android-res/`.

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
