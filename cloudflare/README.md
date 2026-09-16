# ModX Cloudflare API

The Cloudflare projects in this folder provide the ModX game catalogue, executable matching, GitHub Release verification, pre-publication submission review, reactive moderation, and optional SteamGridDB artwork lookup for the desktop app.

## Storage

- D1 (`MODX_DB`): catalogue metadata, executable fingerprints, release/version metadata, attribution, game eligibility, and immutable version-specific review results.
- Queue (`SUBMISSION_REVIEW_QUEUE`): dispatches bounded asynchronous review jobs to `modx-submission-review`.
- Workers AI (`AI` on the review Worker): contextual policy classification after deterministic game, Release, asset, digest, and static-table checks.
- Creator-owned public GitHub Releases: the canonical `.CT` assets, release notes, and version history.
- Worker secrets: `STEAMGRIDDB_API_KEY`, `MODX_ADMIN_TOKEN`, `MODX_BRIDGE_TOKEN`, and optionally `GITHUB_TOKEN` for authenticated GitHub API requests.

## Public endpoints

- `GET https://modx.vortex-prime-emu.com/health`
- `GET https://modx.vortex-prime-emu.com/steamgriddb/search?q=watch+dogs`
- `GET https://modx.vortex-prime-emu.com/games?q=watch`
- `GET https://modx.vortex-prime-emu.com/tables?executable=WatchDogs.exe&platform=windows`
- `GET https://modx.vortex-prime-emu.com/tables/:id/releases/latest` refreshes the listing from the same repository's latest published GitHub Release.
- Table records return structured GitHub repository, release, version, and `.CT` asset metadata. ModX has no local table download endpoint.

## Protected endpoints

Send `Authorization: Bearer <MODX_ADMIN_TOKEN>`.

- `POST /admin/games` with JSON containing `title`, `steamGridDbId`, `artworkUrl`, and an `executables` array.
- `POST /admin/tables` and legacy `/tables/:id/download` return `410 Gone`; direct `.CT` upload and hosting are disabled.
- `POST /admin/tables/:id/take-down` with `{ "reason": "..." }` disables a listing without deleting its historical metadata.
- `POST /admin/games/:id/block` with `{ "reason": "..." }` blocks new uploads and hides existing tables for an online-only game.
- `PUT /admin/games/:id/eligibility` with `status` set to `eligible`, `online_only`, `server_sided`, `unsuitable`, or `review` records the central support-catalogue decision. An unclassified game requires manual review and cannot automatically pass.
- `DELETE /admin/games/:id/block` removes a game block without republishing old tables.
- `POST /admin/abuse/:privateAbuseKey/block` with `{ "reason": "..." }` blocks a repeat uploader without exposing their account identity publicly.

`POST /community/resolve-release` is bridge-only. It requires an HTTPS URL with the exact form `https://github.com/OWNER/REPOSITORY/releases/tag/TAG`, verifies the public release through GitHub's API, and returns its tag/version and `.CT` assets. If a release contains multiple `.CT` assets, the caller must select one explicitly.

`POST /community/reviews` is bridge-only. It re-verifies the exact public Release and selected `.CT` asset, stores a queued version-specific review, and dispatches it to the review Worker. `GET /community/reviews/:id` returns only the requesting uploader's concise status, checks, decision, confidence, reasons, and flags.

`POST /community/submit` is bridge-only and accepts JSON containing the locally derived executable filename/fingerprint, verified GitHub Release source, selected release asset, attribution, `maintenanceMode` (`author` or `community`), the review ID, and the offline/single-player declaration. Publication requires an unconsumed `PASS` tied to the same uploader, game fingerprint, maintenance choice, repository, Release ID/tag, selected asset ID, and computed asset SHA-256. The Worker also re-verifies GitHub before committing the listing. Neither the executable nor the `.CT` asset is uploaded to ModX.

The API Worker checks published listings hourly. A newer Release creates a fresh review job; it never inherits an older version's approval and is promoted only after the new asset passes. `GET /community/my-tables` returns only listings matching the authenticated uploader key. `POST /community/tables/:id/refresh` is the owner-only manual fallback when an automatic check has not appeared yet; it cannot change the canonical repository or bypass review.

Maintenance contributions are managed through GitHub. `community` means the wider community may submit updates for review, accepted updates are merged into the same canonical repository, and official Releases continue to be published from that repository. ModX never switches the listing to a contributor's copy or alternate repository and does not operate its own proposal, source-replacement, or approve/reject workflow.

`POST /community/tables/:id/report` is also bridge-only. Supported reasons include `online_or_multiplayer_cheating` (shown to users as `Online or multiplayer cheating`). Reports remain available as post-publication moderation signals.

## Submission review Worker

`wrangler.review.jsonc` deploys `modx-submission-review` as a Queue consumer with no public HTTP route. It fetches only derived `api.github.com` endpoints, applies size and timeout limits, rejects external XML declarations, decodes bounded `.CT` text, and statically extracts Cheat Engine descriptions, process names, comments, Auto Assembler, and Lua text. It never executes submitted code. Deterministic policy checks run before a constrained JSON-only AI classification. AI failure or uncertainty yields `REVIEW`, never `PASS`.

Review outcomes are exactly `pass`, `review`, or `reject`. Online-only/server-sided/unsuitable game classifications and malformed/missing assets reject immediately. Unknown game eligibility, contradictory content, process mismatch, risky system/network primitives, classifier uncertainty, or infrastructure failure require manual review. Anti-cheat or DRM discussion alone is not a rejection reason, and offline-use warnings are treated as safe context.

Apply migration `0010_submission_reviews.sql`, create `modx-submission-reviews` and `modx-submission-reviews-dead`, deploy the review consumer, and then deploy the API producer. Configure an optional `GITHUB_TOKEN` secret separately on the review Worker to increase GitHub API limits; never commit it.

The SteamGridDB and GitHub credentials must only exist as Worker secrets. Do not place either credential in the desktop app, website source, or repository.
