# Community catalog contract

The catalog is data-driven so publishing a trainer never requires a ModX desktop update. ModX owns this database. SteamGridDB is optional and is used only by the website to search for a game and obtain artwork.

## Website upload flow

1. The contributor types a game name.
2. The website searches SteamGridDB for game identity and artwork only.
3. The contributor selects the correct result and cover image.
4. The contributor uploads a `.CT` file.
5. The contributor supplies one or more supported executable names, such as `Game-Win64-Shipping.exe`.
6. The contributor confirms offline/single-player use and the ModX service performs automatic technical and security validation.
7. The ModX database stores its own game, executable, artwork reference, and table-release records.
8. A valid table is published immediately; the community can report it and administrators can take it down immediately.
9. The desktop app queries the ModX service using the selected executable identity and displays compatible tables automatically.

SteamGridDB does not store ModX cheat tables, process mappings, compatibility records, users, moderation state, or releases. A SteamGridDB ID is merely an optional external reference. ModX must continue to work if that external artwork service is temporarily unavailable.

## Core records

### Game

- ModX game ID
- Display name
- Optional SteamGridDB game ID
- Cached/approved artwork URLs and attribution metadata
- Executable aliases

### Table release

- ModX release ID and game ID
- Uploaded `.CT` object key and SHA-256 digest
- Supported executable names
- Optional executable hashes for exact-version matching
- Table version and supported game versions
- Contributor and licence declaration
- Published/taken-down status, automatic scan results, and offline-only declaration
- Created, updated, revoked, and superseded timestamps

## Upload bundle

Every release contains:

- The original `.CT` file.
- A `modx.json` presentation and compatibility manifest.
- A SHA-256 digest for every file.
- The uploader's signature and licence declaration.
- Optional, appropriately licensed cover and hero artwork.

## Example manifest

```json
{
  "schemaVersion": 1,
  "game": {
    "slug": "example-game",
    "title": "Example Game",
    "steamGridDbId": 123456,
    "processes": ["ExampleGame-Win64-Shipping.exe"]
  },
  "release": {
    "version": "1.2.0",
    "gameVersions": ["1.8.4"],
    "tableFile": "example-game.ct",
    "tableSha256": "<64 lowercase hexadecimal characters>"
  },
  "controls": [
    {
      "id": "unlimited-health",
      "recordPath": ["Player", "Unlimited Health"],
      "label": "Unlimited health",
      "group": "Player",
      "kind": "toggle",
      "defaultHotkey": "F1"
    }
  ]
}
```

`recordPath` maps a visible ModX control to a record inside the cheat table. The website validates that each path exists before accepting a release.

## Client flow

1. Fetch `/v1/catalog/index.json` with an ETag.
2. Verify the catalog signature before reading entries.
3. Compare release IDs with the local SQLite cache.
4. Download changed assets from immutable, content-addressed URLs.
5. Verify sizes and SHA-256 digests before moving files into the active cache.
6. Keep the last verified catalog for offline use.

## Immediate publishing and reactive moderation

- Reject executables, DLLs, archives, and unexpected file types.
- Parse XML with external entities and network access disabled.
- Record Lua and Auto Assembler content in automatic scan results.
- Run static rules and malware scanning in isolated infrastructure.
- Display the exact table version, author, source, game compatibility, scan status, and permissions in the app.
- Publish valid uploads immediately without pending review or contributor ranks.
- Require the uploader to confirm offline/single-player use.
- Support reports, immediate takedowns, online-only game blocks, repeat-uploader blocks, and catalog kill-switches.
- Keep abuse identifiers private and never return them from public catalogue APIs.

Cheat-table Lua is executable code. A clean XML parse or antivirus result is not proof that a table is safe.
