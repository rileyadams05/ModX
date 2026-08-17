# ModX Cloudflare API

This Worker provides the ModX game catalogue, executable matching, immediate community cheat-table publishing to GitHub, reactive moderation, and optional SteamGridDB artwork lookup for the desktop app.

## Storage

- D1 (`MODX_DB`): small metadata only—games, executable aliases, GitHub paths, checksums, moderation status, and audit records.
- GitHub (`rileyadams05/ModX`): the actual `.CT` files under `tables/`.
- Worker secrets: `STEAMGRIDDB_API_KEY`, `MODX_ADMIN_TOKEN`, `MODX_BRIDGE_TOKEN`, and a repository-scoped `GITHUB_TOKEN`.

## Public endpoints

- `GET https://modx.vortex-prime-emu.com/health`
- `GET https://modx.vortex-prime-emu.com/steamgriddb/search?q=watch+dogs`
- `GET https://modx.vortex-prime-emu.com/games?q=watch`
- `GET https://modx.vortex-prime-emu.com/tables?executable=WatchDogs.exe&platform=windows`
- `GET https://modx.vortex-prime-emu.com/tables?steamGridDbId=12345&platform=windows`
- `GET https://modx.vortex-prime-emu.com/tables/:id/download`

## Protected endpoints

Send `Authorization: Bearer <MODX_ADMIN_TOKEN>`.

- `POST /admin/games` with JSON containing `title`, `steamGridDbId`, `artworkUrl`, and an `executables` array.
- `POST /admin/tables` as multipart form data containing `gameId`, `version`, `supportedPlatforms` (JSON array), `executables` (JSON object keyed by platform), optional legacy `executableIds`, and `file` (`.CT`).
- `POST /admin/tables/:id/take-down` with `{ "reason": "..." }` performs the `Take down immediately` action, removes the GitHub file, and disables downloads.
- `POST /admin/games/:id/block` with `{ "reason": "..." }` blocks new uploads and hides existing tables for an online-only game.
- `DELETE /admin/games/:id/block` removes a game block without republishing old tables.
- `POST /admin/abuse/:privateAbuseKey/block` with `{ "reason": "..." }` blocks a repeat uploader without exposing their account identity publicly.

`POST /community/submit` is reserved for the authenticated Vortex Prime website Worker. It derives the game title from the locally selected executable and requires its filename/size/SHA-256 fingerprint, `serviceScope` (`single` or `multiple`), a JSON `services` array, `futureServiceSupport`, `maintenancePolicy` (`uploader` or `community`), and the offline/single-player declaration. Community-maintained submissions must also include a completed `README.md`; every template field is validated and the README is committed beside the table in GitHub. The selected game executable itself is never uploaded. The Worker runs automatic validation and publishes valid submissions immediately.

`POST /community/tables/:id/report` is also bridge-only. Supported reasons include `online_or_multiplayer_cheating` (shown to users as `Online or multiplayer cheating`). Reports are reactive moderation signals; they do not create a pre-publication approval queue.

The SteamGridDB and GitHub credentials must only exist as Worker secrets. Do not place either credential in the desktop app, website source, or repository.
