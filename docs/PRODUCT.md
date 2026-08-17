# ModX product direction

ModX is a free, community-run desktop library for single-player Cheat Engine tables. It deliberately excludes subscriptions, usage timers, advertisements, recording, maps, rewards, and unrelated gaming features.

## Core experience

1. A player creates the services they use and selects each service's main game-library folder once.
2. ModX discovers the immediate game folders, remembers the service configuration, and rescans it without duplicating entries.
3. The app downloads a small signed catalog from the ModX service.
4. Tables are matched using executable names and optional executable hashes.
5. A player selects a compatible community table and reviews its safety information.
6. The trainer runtime loads the cached `.CT` file and exposes its declared controls through the ModX interface.
7. Catalog and table changes arrive independently of desktop application releases.

## Game identity and artwork

The ModX website uses SteamGridDB only as a search-and-artwork provider during submission. The contributor selects a structured search result, confirms offline/single-player use, and uploads one `.CT` file. Valid tables pass automatic checks and publish immediately. Reports, immediate takedowns, game blocking, and private repeat-abuse controls provide reactive moderation. SteamGridDB is not the trainer database and is not required at trainer runtime.

## Visual system

The interface borrows familiar desktop trainer conventions rather than proprietary WeMod assets: persistent game navigation, a large game identity header, one prominent launch action, grouped controls, and visible hotkeys. ModX uses its own purple/teal identity, compact card language, typography, spacing, iconography, and community-status treatment.

## Product boundaries

- Windows-first and focused on offline or single-player use.
- No anti-cheat bypasses, multiplayer cheating, DRM circumvention, or protected game content.
- No copied game artwork without a licensed source. Community submissions must declare their artwork and table licences.
- No arbitrary unsigned table execution.
- The website is the publishing and moderation surface; the desktop app is the discovery and execution surface.

## Delivery stages

### Stage 1: desktop shell

Live process selection, persisted executable targets, honest trainer availability states, settings, and Tauri packaging.

### Stage 2: catalog service

Accounts, uploads, automatic validation, immediate publishing, reports, takedowns, immutable releases, signatures, and a read-only public API.

### Stage 3: runtime bridge

Table parsing, strict metadata validation, process matching, isolated execution, named-pipe control, hotkeys, crash recovery, and audit logs.

### Stage 4: service libraries

User-defined services, selected library roots, idempotent rescans, sensible executable discovery, direct launching, and persistent out-of-library games learned through the running-process selector.
