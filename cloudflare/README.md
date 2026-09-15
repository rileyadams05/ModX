# ModX Cloudflare API

This Worker provides the ModX game catalogue, executable matching, immediate community cheat-table publishing to GitHub, reactive moderation, and optional SteamGridDB artwork lookup for the desktop app.

## Storage

- D1 (`MODX_DB`): catalogue metadata, executable fingerprints, GitHub sources, attribution, maintenance proposals, and moderation state.
- Creator-owned public GitHub repositories: the canonical `.CT` files and README documentation.
- Worker secrets: `STEAMGRIDDB_API_KEY`, `MODX_ADMIN_TOKEN`, `MODX_BRIDGE_TOKEN`, and a repository-scoped `GITHUB_TOKEN`.

## Public endpoints

- `GET https://modx.vortex-prime-emu.com/health`
- `GET https://modx.vortex-prime-emu.com/steamgriddb/search?q=watch+dogs`
- `GET https://modx.vortex-prime-emu.com/games?q=watch`
- `GET https://modx.vortex-prime-emu.com/tables?executable=WatchDogs.exe&platform=windows`
- `GET https://modx.vortex-prime-emu.com/tables?steamGridDbId=12345&platform=windows`
- Table records return their validated GitHub source; ModX has no local table download endpoint.

## Protected endpoints

Send `Authorization: Bearer <MODX_ADMIN_TOKEN>`.

- `POST /admin/games` with JSON containing `title`, `steamGridDbId`, `artworkUrl`, and an `executables` array.
- `POST /admin/tables` and legacy `/tables/:id/download` return `410 Gone`; direct `.CT` upload and hosting are disabled.
- `POST /admin/tables/:id/take-down` with `{ "reason": "..." }` performs the `Take down immediately` action, removes the GitHub file, and disables downloads.
- `POST /admin/games/:id/block` with `{ "reason": "..." }` blocks new uploads and hides existing tables for an online-only game.
- `DELETE /admin/games/:id/block` removes a game block without republishing old tables.
- `POST /admin/abuse/:privateAbuseKey/block` with `{ "reason": "..." }` blocks a repeat uploader without exposing their account identity publicly.

`POST /community/submit` is bridge-only and accepts JSON containing the executable filename/fingerprint, normalized GitHub source, attribution, `maintenanceMode` (`author` or `community`), and the offline/single-player declaration. Neither the executable nor the `.CT` file is uploaded.

Community-enabled listings accept proposed GitHub sources through `POST /community/tables/:id/maintenance-submissions`. Proposals remain `pending_review` until an admin approves or rejects them through `/admin/maintenance-submissions/:id/approve` or `/reject`. Approval changes the current source and maintainer while preserving original attribution.

`POST /community/tables/:id/report` is also bridge-only. Supported reasons include `online_or_multiplayer_cheating` (shown to users as `Online or multiplayer cheating`). Reports are reactive moderation signals; they do not create a pre-publication approval queue.

The SteamGridDB and GitHub credentials must only exist as Worker secrets. Do not place either credential in the desktop app, website source, or repository.
