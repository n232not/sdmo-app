# Privacy Policy

**Effective date:** July 1, 2026

SDMo is an open-source desktop application for research teams that code patient encounter media. This policy explains what information the app handles and how that information is stored or shared.

## Summary

SDMo is not a hosted cloud service. The app primarily stores data locally on your computer. When you choose to configure sync, SDMo writes project and review data to the sync location you select, such as a shared local folder, OneDrive, or Google Drive.

## Information SDMo Handles

Depending on how your team uses the app, SDMo may handle:

- Project names, descriptions, encounter names, media-file names, media types, forms, instructions, and app settings.
- Reviewer names, review status, timestamps, timestamp labels, notes, and form responses entered by coders.
- Local file paths used to link media files on a specific computer.
- Cloud account email addresses and OAuth tokens when you connect OneDrive or Google Drive.
- Diagnostics exported by a user, such as app version, system details, backup list, logs, and project counts.

## Media Files

SDMo is designed so video, audio, PDF, and other media files remain on each user's computer. SDMo does not upload media files through its own service. If your team stores media in a cloud folder outside SDMo, that storage is controlled by your team and the cloud provider you choose.

## Local Storage

SDMo stores project and review data in a local SQLite database on the user's computer. It also stores local app settings, sync configuration, cloud tokens, and local media links as needed for the app to work.

## Sync and Cloud Providers

If you enable sync, SDMo shares project structure and review data with the folder or cloud account you select. Sync files may include project configuration, encounters, media-file records, reviewer names, timestamps, notes, form responses, and submitted review data. Local media-file links are device-specific and are not intended to be used as shared media storage.

For OneDrive, SDMo uses Microsoft Graph permissions to read and write files in the connected user's drive. For Google Drive, the current app requests Google Drive API access so it can list folders and read/write sync files in the selected project folder. SDMo uses Google user data only to provide user-facing sync features.

## Google API Data Use

SDMo's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. SDMo does not sell Google user data, use it for advertising, or transfer it except as needed to provide sync functionality, comply with applicable law, or with the user's consent.

## What the Project Maintainer Receives

The project maintainer does not automatically receive your project data, review data, media files, cloud files, or OAuth tokens. If you open a GitHub issue, send diagnostics, or otherwise contact the maintainer, you choose what information to provide.

## Security

SDMo uses operating-system and local-app storage mechanisms available to an Electron desktop app. No software can guarantee perfect security. Your team is responsible for securing computers, cloud accounts, shared folders, access permissions, backups, and any research data governed by institutional or legal requirements.

## Healthcare and Research Data

SDMo may be used with sensitive research data, but SDMo is not itself a covered-entity service, medical device, clinical decision support tool, or compliance certification. Your organization is responsible for consent, IRB or ethics review, data-use agreements, HIPAA or other regulatory obligations, and secure handling of media and review data.

## Children's Privacy

SDMo is intended for use by research teams and is not directed to children as end users.

## Changes

This policy may be updated as SDMo changes. The effective date above will be updated when material changes are made.

## Contact

For privacy questions, open an issue at [github.com/n232not/sdmo-app/issues](https://github.com/n232not/sdmo-app/issues).
