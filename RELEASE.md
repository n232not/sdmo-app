# SDMo Release Checklist

Use this for every alpha or production release. SDMo releases are migration-sensitive because installed testers keep local SQLite data, app settings, sync credentials, and per-machine media links between versions.

## 1. Before Coding a Release

- Decide whether this release is optional or required.
- Use a required update only when old clients would be unsafe or incompatible, such as a sync protocol change, destructive migration risk, security issue, or export correctness issue.
- If the release changes SQLite schema, append migrations only. Do not edit `initSchema` or existing `runDataMigrations()` entries.
- If a migration rewrites existing data, make it a new `runDataMigrations()` entry and confirm a backup is created before the risky operation.

## 2. Required Update Marker

To force testers to update, include this marker in the GitHub Release notes:

```text
[sdmo-update:required]
```

Normal releases omit that marker. SDMo will still prompt users, but they can choose Later.

## 3. Version and Build

- Bump `package.json` version.
- Run `npm install` if dependencies changed so `package-lock.json` is current.
- Run `npm test`.
- Run `npm run build`.
- Build release artifacts with `npm run dist:mac` and/or `npm run dist:win`.
- Confirm Electron Builder generated update metadata files alongside the installers.
- Mac in-app updates only work from Developer ID signed builds. For unsigned/test mac builds, distribute the DMG manually and leave `SDMO_ENABLE_MAC_AUTO_UPDATE` unset so SDMo does not offer a broken ShipIt update.

## 4. Migration Safety Test

- Install or launch the previous released version.
- Create or open a project with encounters, media files, reviews, timestamps, forms, media types, and sync settings.
- Install the new version over the old one.
- Confirm the same local projects, reviews, settings, cloud/local sync settings, and media links still work.
- Confirm a startup backup exists in `userData/backups`.

## 5. Update Flow Test

- Publish a draft GitHub Release with the installer artifacts and update metadata.
- Confirm an installed older SDMo build sees the update.
- For normal releases, confirm users can choose Later.
- For required releases, confirm SDMo blocks usage until Restart to Install.
- Confirm SDMo creates a `pre-app-update` database backup before installing.

## 6. Diagnostics

- Open Setup -> About.
- Confirm the visible app version matches `package.json`.
- Export diagnostics and verify it contains version/system/project-count information, not media files or review contents.

## 7. Publish

- Publish the GitHub Release.
- Include human-readable release notes.
- Mention whether the update is required and why.
- Keep the prior release available until the new version has been smoke-tested by at least one real installed client.

## 8. Smoke Test Script

Run this against a packaged app before giving a release to alpha testers. Mark each line pass/fail and paste notes under "Result Notes" below.

### Fresh Launch

- Install/open the packaged app, not `npm run dev`.
- Confirm SDMo launches without a terminal or Vite dev server.
- Open Settings -> About.
- Confirm the visible app version matches `package.json`.

### Project Creation

- Create a new project named `Smoke Test`.
- Confirm Setup opens.
- Set your reviewer name.
- Add one form with at least one required question.
- Add one media type.
- Add one timestamp tag.
- Add the form to the media type workspace.

### Encounter and Media

- Add one encounter.
- Add one media file entry.
- Link it to a local sample video, audio file, PDF, or other supported test file.
- Confirm the file appears linked in Settings -> Files.
- Open the media file from the project page.

### Review Flow

- Create a review.
- Add one timestamp.
- Fill out the form.
- Submit the review.
- Reopen the review.
- Confirm the timestamp, form response, status, and reviewer name persisted.

### Export

- Export Excel from the project page.
- Open the workbook.
- Confirm the review appears.
- Confirm the timestamp appears.
- Confirm the form response appears.
- Confirm the codebook/version sheets are present.

### Local Sync

- Configure local-folder sync to a temporary empty folder.
- Click Sync Now.
- Confirm `project-state.json` and `manifest.json` appear in the sync folder.
- Join/import that sync folder as a second local project if practical.
- Confirm the submitted review appears after sync.

### Upgrade Safety

- Install the previous released version.
- Create or open a project with a submitted review.
- Install the new version over the old version.
- Confirm the same project and submitted review still exist.
- Confirm Settings -> About shows the new version.
- Confirm a startup backup exists in `userData/backups`.

### Diagnostics

- Open Settings -> About.
- Click Export Diagnostics.
- Open the exported JSON.
- Confirm it includes app version, platform, backup list, project counts, and recent logs.
- Confirm it does not include media files or review contents.

### Normal Update Prompt

- Publish a draft/test GitHub Release without the required marker.
- Launch an older installed build.
- Confirm SDMo detects the newer version.
- Confirm the update can be dismissed with Later.
- Download the update.
- Confirm Restart to Install appears.
- Restart/install and confirm the app opens at the new version.

### Required Update Prompt

- Publish a draft/test GitHub Release that includes `[sdmo-update:required]` in the release notes.
- Launch an older installed build.
- Confirm SDMo blocks use until the update is installed.
- Download the update.
- Click Restart to Install.
- Confirm a `pre-app-update` database backup is created.
- Confirm the app opens at the new version with the same project data.

### Result Notes

```text
Release version:
Tester:
Date:
Platform:
Package file tested:

Fresh Launch:
Project Creation:
Encounter and Media:
Review Flow:
Export:
Local Sync:
Upgrade Safety:
Diagnostics:
Normal Update Prompt:
Required Update Prompt:

Blockers:
Follow-ups:
```
