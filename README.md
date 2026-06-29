<mark>Please read in full before downloading</mark>

# SDMo — Patient Encounter Coding App

SDMo is a desktop application for research studies where coders watch videos (or review documents) of clinical encounters and log timestamped observations while filling out structured forms. 

---

## Downloading the App

### Step 1 — Go to the Releases page

Click **[Releases](https://github.com/n232not/sdmo-app/releases)** on the right side of this page, or go to:
**github.com/n232not/sdmo-app/releases**

### Step 2 — Download the right file for your computer

| Your computer | File to download |
|---|---|
| **Mac (Apple Silicon / M1, M2, M3, M4)** | `SDMo-x.x.x-arm64.dmg` |
| **Windows** | `SDMo-x.x.x-Setup.exe` |

> **Not sure which Mac you have?** Click the Apple menu () → About This Mac. If it says "Apple M1" (or M2, M3, M4), download the arm64 DMG.

### Step 3 — Install

**Mac:** Open the `.dmg` file, then drag the SDMo icon into your Applications folder.

<mark>If macOS says "SDMo cannot be opened because it is from an unidentified developer", run 'xattr -cr /Applications/SDMo.app' in Terminal. This is expected since this app is not currently liscenced and is a testing version</mark>

**Windows:** Run the `.exe` installer and follow the prompts. If Windows Defender shows a warning, click **More info → Run anyway**.

---

## Updating the App

SDMo checks GitHub Releases for newer versions. When an update is available, you will be notified in the app. On Windows, you will have an option to autoupdate within the app. On Mac, you will have to go to the github releases page and reinstall the app from scratch. You can also always check the current version of the app and if a newer version is available in the about tab in settings.

## What SDMo Does

SDMo organizes research coding sessions around **Projects**, **Encounters**, and **Reviews**.

### Projects
A project holds everything for one study — its encounters, media files, forms, instructions, and coder settings. You create or join a project from the home screen.

### Encounters
Each encounter represents one clinical session (e.g. a patient visit). An encounter can have one or more media files — videos or documents — that coders review.

### Reviews
When a coder opens a media file, they create a **Review**. Inside a review they can:
- **Log timestamps** — click a tag or press a keyboard shortcut to mark a moment in the video with a label and optional note
- **Fill out forms** — structured questionnaires that appear in tabs alongside the video
- **Submit** — mark the review complete when done

### Multi-User / Sync

SDMo supports syncing across multiple coders' machines so a team can work on the same project simultaneously.

- **OneDrive or Google Drive** — connect from Setup → Sync. Each coder connects their own account and points to the shared project folder. The app syncs automatically in the background.
- **Local folder** — point all machines to a shared network drive or a locally-synced cloud folder (Dropbox, OneDrive desktop sync, etc.)

The project admin sets up the encounters, forms, and media types. Coders only need to join and start reviewing — they do not need to configure anything beyond entering their name and connecting to the shared folder.

