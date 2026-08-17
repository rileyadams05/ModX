# ModX

ModX is a free, community-driven Windows trainer library built with Rust, Tauri 2, React, and TypeScript.

The desktop app now has two coordinated selection flows:

- A service-agnostic installed-game library. Users create the services they use, choose each service's main library folder once, and ModX discovers immediate child game folders. No launcher names or vendor-specific providers are hard-coded.
- A Cheat Engine-style running-process picker for games installed outside a service's main root. The user assigns the selected process to one of their configured services, and ModX permanently saves the executable path as a normal game entry.

Saved games use normalized install/executable paths rather than temporary PIDs. Library refreshes reconcile a fresh scan with saved individual games, so repeated refreshes are stable and learned games remain after their process closes.

Community table execution is intentionally not connected yet; the trust, package-validation, and runtime boundaries must be implemented before community `.CT` files are allowed to run.

## Development

Install dependencies, then run the native desktop window:

```text
npm install
npm run tauri dev
```

The development window uses built local assets and does not depend on a localhost server.

To create the final Windows `.msi` installer:

```text
npm run tauri build
```

See `docs/PRODUCT.md` and `docs/CATALOG.md` for the product and community publishing architecture.

## Repository layout

- `src/` — React desktop interface.
- `src-tauri/` — Rust and Tauri 2 desktop application.
- `cloudflare/` — ModX catalogue API, validation, GitHub storage integration, and database migrations. Production secrets are configured outside Git and are never committed.
- `website/` — public ModX publishing and community-table browser source. Vortex Prime hosts these pages and keeps the private account/session bridge in its own repository.
- `tables/` — created automatically when valid community `.CT` files are published. The table files live in this repository rather than Vortex Prime website storage.
