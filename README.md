# Archicad License Logger

Logs how many of CAST's floating Archicad licenses are in use, and by whom,
to the **Archicad License Usage** Google Sheet every 10 minutes.

How it works: a small Chrome extension on the office server uses its
Graphisoft sign-in to read the same data the Cloud Licenses page shows, then
sends each reading to a short Apps Script attached to the sheet, which
appends the rows. The sheet's Dashboard charts update on their own.

## How changes get made

Changes are proposed as pull requests on this repo. Each one describes the
change in plain English, shows the exact code differences, and runs the tests
automatically.

- **To approve:** review the pull request and click **Merge** (or tell Claude
  "merge it").
- **The server installs it by itself:** a scheduled task pulls `main` every
  10 minutes, and the extension reloads itself when its version number changes.
  Changes are live within about 20 minutes, with no clicks on the server.
- **To undo:** revert the pull request on GitHub. The server rolls back the same way.
- **Apps Script changes** deploy automatically too once the optional setup at
  the end of this file is done; until then, paste `apps-script/Code.gs` by hand.
- **Sheet changes** (charts, formulas, tabs) are made directly in the sheet;
  its version history is the undo.

Every change to `extension/` must bump `version` in `extension/manifest.json`;
the tests fail the pull request otherwise, since the version change is what
tells the server's extension to reload.

## Server setup (once)

On the server, in PowerShell opened with **Run as administrator**:

1. If Git for Windows isn't installed, install it from
   https://git-scm.com/download/win with the default options.
2. Download `server/setup-server.ps1` from this repo and run:
   `powershell -ExecutionPolicy Bypass -File setup-server.ps1`
3. It creates a read-only key for this repo, copies it to the clipboard and opens
   GitHub's "Add deploy key" page. Paste it, leave **Allow write access**
   unchecked, and click **Add key**.
4. It downloads the repo to `C:\ArchicadLicenseLogger` and schedules the
   10-minute update task (runs hidden, as SYSTEM).
5. Follow the last steps it prints: copy the Web app URL and Shared key from
   the old extension, remove it, **Load unpacked** from
   `C:\ArchicadLicenseLogger\extension`, paste the URL and key, and sign in to
   Graphisoft on the pinned tab.

The extension has a fixed ID, so its settings are kept through every update.

## Connecting the sheet (first-time setup, already done)

1. Open the **Archicad License Usage** sheet.
2. **Extensions > Apps Script**. Delete what's in `Code.gs` and paste in the
   contents of `apps-script/Code.gs` from this repo. Click **Save** (disk icon).
3. In the function dropdown at the top, pick **setupKey**, then click **Run**.
   Google asks you to authorize it: choose your account, then
   **Advanced > Go to (project name) (unsafe) > Allow**. The warning appears
   because the script is yours and not published; it only touches this sheet.
4. The **Execution log** at the bottom shows `Shared key for the extension: ...`.
   Copy that key.
5. **Deploy > New deployment**. Click the gear next to "Select type" and pick
   **Web app**. Set:
   - Execute as: **Me**
   - Who has access: **Anyone**
   Click **Deploy** and copy the **Web app URL** (ends in `/exec`).

"Anyone" is needed so the extension can post without a Google login. Requests
without the shared key are rejected, and the web app can only add rows.

## Day to day

- The toolbar badge shows how many licenses are in use: green with 3 or more
  free, amber with 1 or 2 free, red when all are taken, grey **!** when it
  can't read Graphisoft.
- Readings are taken at :00, :10, :20 and so on, from 6:00 to 20:00, every day.
  Change this under Settings. If you change the interval, also change
  **Settings > Sample interval** in the sheet so the hours-per-person figures
  stay right.
- Readings only happen while Chrome is running on that computer. To cover
  gaps, install the extension on a second computer with the same URL and key;
  the sheet keeps only one reading per interval.
- If the sheet can't be reached, readings are kept in the extension and sent
  on the next successful run.
- Graphisoft signs you out after a few hours without activity, and signing in
  needs a password and an authenticator code, so it can't be automated. To
  prevent that, the extension keeps a pinned Graphisoft tab open and reloads it
  every 10 minutes, day and night. It leaves the tab alone while it shows the
  sign-in page or while someone is using it. Don't close that tab; if you do,
  it comes back on the next tick. You can turn this off under Settings.
- If the sign-in lapses anyway, the extension logs one "Signed out of
  Graphisoft" row, the icon shows **!**, and the sheet emails you. Click
  **Open Graphisoft to sign in** in the popup, sign in on the pinned tab, and
  readings resume right away.
- On the server, set Chrome to **Settings > On startup > Continue where you
  left off**, so the Graphisoft sign-in and the pinned tab survive a Chrome
  restart.

## What gets logged

- **Log**: one row per reading: time, licenses, in use, available, who, status.
  Rows where every license was taken are highlighted.
- **User log**: one row per person per reading, with the computer name.
- **Daily**, **By hour**, **By person**, **Timeline**: summaries built by formulas.
- **Dashboard**: the charts, including the timeline of who held a license
  during the day shown in its **Day shown** cell.

"In use" means Graphisoft shows that person holding a floating license.
Graphisoft releases an idle floating license after roughly 30 minutes, so
someone who walks away from Archicad drops off within a reading or two.

## Email alerts

The sheet's Apps Script checks the log every 10 minutes and emails:

- when no reading has reached the sheet for 30 minutes between 6:00 and 20:00,
  with a reminder every 4 hours while it lasts and one email when readings resume
- at most once an hour while no Archicad licenses are available, listing who
  has them

Each email ends with links to the sheet's Dashboard and to Graphisoft's cloud
license page. Because the check runs inside Google, it still works when the
server is off.

To turn alerts on: in **Extensions > Apps Script**, replace `Code.gs` with the
current version, click **Save**, pick **setupAlerts** in the function dropdown
and click **Run**. Google asks for permission again, this time to send email
and run on a schedule. A confirmation email arrives within a minute.
No new deployment is needed.

Recipients, the no-reading delay, alert hours and weekends are on the sheet's
**Settings** tab. Separate several addresses with commas.

## Updating the Apps Script by hand

Paste the new `apps-script/Code.gs` into the editor and click **Save**. Changes
to the alerts take effect right away. For changes to how readings are received,
also use **Deploy > Manage deployments**, click the pencil, set
**Version: New version**, and **Deploy**. The URL stays the same.

## Optional: automatic Apps Script deploys

The **Deploy Apps Script** workflow pushes `apps-script/` and redeploys the web
app whenever a merged change touches it. It stays off until all of this is set:

1. Turn on **Google Apps Script API** at https://script.google.com/home/usersettings.
2. On a computer with Node.js: `npx @google/clasp@2.4.2 login`, then copy the
   contents of the `.clasprc.json` file it creates in your home folder.
3. In this repo on GitHub: **Settings > Secrets and variables > Actions**:
   - Secret `CLASPRC_JSON`: the contents you copied.
   - Variable `APPS_SCRIPT_DEPLOYMENT_ID`: from the Apps Script editor,
     **Deploy > Manage deployments**, the web app's Deployment ID.
4. Put the script's ID (Apps Script editor > **Project Settings** > Script ID)
   into `apps-script/.clasp.json` as `scriptId`.

The `CLASPRC_JSON` secret can read and change your Google Drive and scripts,
not just this one, so keep this repo private.

## Running the tests

`npm ci`, then `npm test` (logger, alerts and Apps Script receiver) and
`npm run test:browser` (self-update in a real Chromium; run
`npx playwright install chromium` first).
