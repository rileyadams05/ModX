# ModX Cloudflare API

This Worker provides the ModX game catalogue, executable matching, GitHub Release verification, reactive moderation, and optional SteamGridDB artwork lookup for the desktop app.

## Storage

- D1 (`MODX_DB`): catalogue metadata, executable fingerprints, release/version metadata, attribution, and moderation state.
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
- `DELETE /admin/games/:id/block` removes a game block without republishing old tables.
- `POST /admin/abuse/:privateAbuseKey/block` with `{ "reason": "..." }` blocks a repeat uploader without exposing their account identity publicly.

`POST /community/resolve-release` is bridge-only. It requires an HTTPS URL with the exact form `https://github.com/OWNER/REPOSITORY/releases/tag/TAG`, verifies the public release through GitHub's API, and returns its tag/version and `.CT` assets. If a release contains multiple `.CT` assets, the caller must select one explicitly.

`POST /community/submit` is bridge-only and accepts JSON containing the locally derived executable filename/fingerprint, verified GitHub Release source, optional selected release asset, attribution, `maintenanceMode` (`author` or `community`), and the offline/single-player declaration. The Worker verifies the release again before storing it. Neither the executable nor the `.CT` asset is uploaded to ModX.

Maintenance contributions are managed through GitHub. `community` means the wider community may submit updates for review, accepted updates are merged into the same canonical repository, and official Releases continue to be published from that repository. ModX never switches the listing to a contributor's copy or alternate repository and does not operate its own proposal, source-replacement, or approve/reject workflow.

`POST /community/tables/:id/report` is also bridge-only. Supported reasons include `online_or_multiplayer_cheating` (shown to users as `Online or multiplayer cheating`). Reports are reactive moderation signals; they do not create a pre-publication approval queue.

The SteamGridDB and GitHub credentials must only exist as Worker secrets. Do not place either credential in the desktop app, website source, or repository.
