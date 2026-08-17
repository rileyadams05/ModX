# ModX website frontend

This directory contains the public ModX publishing and community-catalogue pages.

The pages are deployed as part of Vortex Prime because they use the existing Vortex Prime domain and account session. The private authentication implementation and Cloudflare bridge remain in the separate `Vortex-Prime-emu` repository. No login secrets or production credentials belong in this repository.

Community Cheat Engine tables are not stored in the Vortex Prime website. Valid uploads are written to this ModX repository under `tables/`, while catalogue metadata is served by the ModX API.
