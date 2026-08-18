const ALLOWED_ORIGINS = new Set([
  "https://vortex-prime-emu.com",
  "https://www.vortex-prime-emu.com",
  "http://localhost:1420",
  "https://tauri.localhost",
  "tauri://localhost",
]);

const PLATFORM_DEFINITIONS = Object.freeze([
  { id: "windows", displayName: "Windows" },
  { id: "linux", displayName: "Linux" },
  { id: "steamos", displayName: "SteamOS" },
  { id: "macos", displayName: "macOS" },
]);
const PLATFORM_IDS = new Set(PLATFORM_DEFINITIONS.map((platform) => platform.id));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), origin);
    }

    try {
      const path = stripPrefix(url.pathname);
      let response;

      if (request.method === "GET" && path === "/health") {
        response = json({ ok: true, service: "modx-api" });
      } else if (request.method === "GET" && path === "/steamgriddb/search") {
        response = await searchSteamGridDb(url, env);
      } else if (request.method === "GET" && path === "/steamgriddb/icon") {
        response = await resolveSteamGridDbIcon(url, env);
      } else if (request.method === "GET" && /^\/steamgriddb\/games\/\d+$/.test(path)) {
        response = json({ game: await resolveSteamGridDbGame(Number(path.split("/")[3]), env) });
      } else if (request.method === "GET" && path === "/games") {
        response = await listGames(url, env);
      } else if (request.method === "GET" && path === "/tables") {
        response = await findTables(url, env);
      } else if (request.method === "GET" && /^\/tables\/[^/]+\/download$/.test(path)) {
        response = await downloadTable(path.split("/")[2], env);
      } else if (request.method === "POST" && path === "/admin/games") {
        requireAdmin(request, env);
        response = await createGame(request, env);
      } else if (request.method === "POST" && path === "/admin/tables") {
        requireAdmin(request, env);
        response = await uploadTable(request, env);
      } else if (request.method === "POST" && path === "/community/submit") {
        requireBridge(request, env);
        response = await submitCommunityTable(request, env);
      } else if (request.method === "GET" && path === "/community/my-tables") {
        requireBridge(request, env);
        response = await listUploaderTables(request, env);
      } else if (request.method === "POST" && /^\/community\/tables\/[^/]+\/report$/.test(path)) {
        requireBridge(request, env);
        response = await reportCommunityTable(request, path.split("/")[3], env);
      } else if (request.method === "POST" && /^\/admin\/tables\/[^/]+\/take-down$/.test(path)) {
        requireAdmin(request, env);
        response = await takeDownTable(request, path.split("/")[3], env);
      } else if (request.method === "POST" && /^\/admin\/games\/[^/]+\/block$/.test(path)) {
        requireAdmin(request, env);
        response = await blockGame(request, path.split("/")[3], env);
      } else if (request.method === "DELETE" && /^\/admin\/games\/[^/]+\/block$/.test(path)) {
        requireAdmin(request, env);
        response = await unblockGame(path.split("/")[3], env);
      } else if (request.method === "POST" && /^\/admin\/abuse\/[a-f0-9]{64}\/block$/.test(path)) {
        requireAdmin(request, env);
        response = await blockUploader(request, path.split("/")[3], env);
      } else {
        response = json({ error: "Not found" }, 404);
      }

      return withCors(response, origin);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error("Unhandled request error", error);
      return withCors(json({ error: status === 500 ? "Internal server error" : error.message }, status), origin);
    }
  },
};

function stripPrefix(pathname) {
  return pathname.startsWith("/api/modx")
    ? pathname.slice("/api/modx".length) || "/"
    : pathname;
}

async function listUploaderTables(request, env) {
  const uploaderAbuseKey = cleanAbuseKey(request.headers.get("X-ModX-Uploader-Key"));
  if (!uploaderAbuseKey) throw new HttpError(401, "Uploader identity is missing");

  const { results } = await env.MODX_DB.prepare(
    `SELECT tr.id, tr.version, tr.original_filename AS filename, tr.sha256,
            tr.file_size AS fileSize, tr.notes, tr.contributor_name AS contributorName,
            tr.status, tr.service_scope AS serviceScope,
            tr.future_service_support AS futureServiceSupport,
            tr.maintenance_policy AS maintenancePolicy,
            tr.download_url AS downloadUrl,
            tr.community_readme_download_url AS communityReadmeDownloadUrl,
            tr.created_at AS createdAt, g.id AS gameId, g.title AS gameTitle
     FROM table_releases tr
     JOIN games g ON g.id = tr.game_id
     WHERE tr.uploader_abuse_key = ?1
     ORDER BY tr.created_at DESC`
  ).bind(uploaderAbuseKey).all();

  const metadataByRelease = new Map(results.map((table) => [table.id, {
    supportedPlatforms: [], executables: {}, services: [],
  }]));
  for (let offset = 0; offset < results.length; offset += 50) {
    const releases = results.slice(offset, offset + 50);
    if (!releases.length) continue;
    const placeholders = releases.map((_, index) => `?${index + 1}`).join(",");
    const bindings = releases.map((table) => table.id);
    const platformRows = await env.MODX_DB.prepare(
      `SELECT table_release_id AS tableReleaseId, platform_id AS platformId,
              executable_name AS executableName
       FROM table_release_platform_executables
       WHERE table_release_id IN (${placeholders})
       ORDER BY table_release_id, platform_id`
    ).bind(...bindings).all();
    for (const row of platformRows.results) {
      const metadata = metadataByRelease.get(row.tableReleaseId);
      if (!metadata) continue;
      if (!metadata.supportedPlatforms.includes(row.platformId)) metadata.supportedPlatforms.push(row.platformId);
      metadata.executables[row.platformId] = row.executableName;
    }
    const serviceRows = await env.MODX_DB.prepare(
      `SELECT table_release_id AS tableReleaseId, service_name AS serviceName
       FROM table_release_services
       WHERE table_release_id IN (${placeholders})
       ORDER BY table_release_id, service_name`
    ).bind(...bindings).all();
    for (const row of serviceRows.results) {
      const metadata = metadataByRelease.get(row.tableReleaseId);
      if (metadata && !metadata.services.includes(row.serviceName)) metadata.services.push(row.serviceName);
    }
  }

  return json({
    tables: results.map((table) => ({
      ...table,
      futureServiceSupport: Boolean(table.futureServiceSupport),
      listedInCommunity: table.maintenancePolicy === "community" && table.status === "published",
      ...metadataByRelease.get(table.id),
    })),
  });
}

async function searchSteamGridDb(url, env) {
  const query = cleanText(url.searchParams.get("q"), 120);
  if (!query || query.length < 2) throw new HttpError(400, "Enter at least two characters");

  const searchResponse = await steamGridRequest(
    `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(query)}`,
    env,
  );
  const seen = new Set();
  const results = (Array.isArray(searchResponse.data) ? searchResponse.data : [])
    .filter((game) => Number.isSafeInteger(game?.id) && game.id > 0 && typeof game.name === "string")
    .filter((game) => !seen.has(game.id) && seen.add(game.id))
    .slice(0, 50)
    .map((game) => ({ id: game.id, name: cleanText(game.name, 160) }));
  return json({ results });
}

async function resolveSteamGridDbIcon(url, env) {
  const query = cleanText(url.searchParams.get("q"), 120);
  const requestedIconId = positiveInteger(url.searchParams.get("iconId"));
  if (!query || query.length < 2) throw new HttpError(400, "Enter a game title");
  console.log(JSON.stringify({ event: "steamgriddb.icon.start", query, apiKeyConfigured: Boolean(env.STEAMGRIDDB_API_KEY), requestedIconId }));
  const expected = normalize(query);
  const searchQueries = controlledTitleCandidates(query);
  const searches = [];
  for (const candidate of searchQueries) {
    searches.push(await steamGridRequest(
      `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(candidate)}`,
      env,
    ));
  }
  const games = searches.flatMap((search) => Array.isArray(search.data) ? search.data : [])
    .filter((game) => Number.isSafeInteger(game?.id) && game.id > 0 && typeof game.name === "string");
  const uniqueGames = [...new Map(games.map((game) => [game.id, game])).values()];
  let exactMatches = uniqueGames
    .filter((game) => normalize(game.name) === expected)
    .sort((a, b) => Number(Boolean(b.verified)) - Number(Boolean(a.verified)));
  if (!exactMatches.length && searchQueries.length > 1) {
    const expectedCore = editionCore(searchQueries[searchQueries.length - 1]);
    const derivativeMatches = uniqueGames.filter((game) => editionCore(game.name) === expectedCore);
    if (derivativeMatches.length === 1) exactMatches = derivativeMatches;
  }
  if (!exactMatches.length) throw new HttpError(404, "No confident SteamGridDB match was found.");

  const game = exactMatches[0];
  const icons = await steamGridRequest(
    `https://www.steamgriddb.com/api/v2/icons/game/${game.id}`,
    env,
  );
  const candidates = (Array.isArray(icons.data) ? icons.data : [])
    .filter((icon) => Number.isSafeInteger(icon?.id) && icon.id > 0)
    .filter((icon) => typeof icon?.url === "string" && /^https:\/\/[^/]*steamgriddb\.com\//i.test(icon.url))
    .filter((icon) => !requestedIconId || icon.id === requestedIconId)
    .sort((a, b) => {
      const aLarge = Math.min(Number(a.width) || 0, Number(a.height) || 0) >= 128 ? 1 : 0;
      const bLarge = Math.min(Number(b.width) || 0, Number(b.height) || 0) >= 128 ? 1 : 0;
      return bLarge - aLarge || (Number(b.score) || 0) - (Number(a.score) || 0) || (Number(b.upvotes) || 0) - (Number(a.upvotes) || 0);
    });
  if (!candidates.length) throw new HttpError(404, "SteamGridDB has no suitable icon for this game.");
  const selected = candidates[0];
  console.log(JSON.stringify({ event: "steamgriddb.icon.resolved", query, searchQueries, searchResultCount: uniqueGames.length, gameId: game.id, iconCount: Array.isArray(icons.data) ? icons.data.length : 0, selectedIconId: selected.id, width: selected.width, height: selected.height }));
  return json({
    apiConfigured: true,
    searchResultCount: uniqueGames.length,
    iconCount: Array.isArray(icons.data) ? icons.data.length : 0,
    game: { id: game.id, name: cleanText(game.name, 160) },
    icon: { id: selected.id, url: selected.url, width: Number(selected.width) || 0, height: Number(selected.height) || 0 },
  });
}

function editionCore(value) {
  const ignored = new Set(["resynced", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"]);
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((part) => part && !ignored.has(part))
    .join("");
}

function controlledTitleCandidates(value) {
  const exact = cleanText(value, 120);
  const normalized = exact.replace(/(?:\s+[-–—]?\s*)(resynced|modded|copy|backup|custom|old)(?:\s*\(\d+\))?$/i, "").trim();
  return normalized && normalize(normalized) !== normalize(exact) ? [exact, normalized] : [exact];
}

async function steamGridRequest(target, env) {
  if (!env.STEAMGRIDDB_API_KEY) {
    console.error(JSON.stringify({ event: "steamgriddb.request.blocked", apiKeyConfigured: false }));
    throw new HttpError(503, "SteamGridDB API key is not configured");
  }
  let response;
  try {
    response = await fetch(target, {
      headers: {
        Authorization: `Bearer ${env.STEAMGRIDDB_API_KEY}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    console.error("SteamGridDB request failed", { name: error?.name, message: error?.message });
    throw new HttpError(502, "Unable to search games right now. Try again.");
  }
  if (!response.ok) {
    console.error(JSON.stringify({ event: "steamgriddb.request.error", apiKeyConfigured: true, status: response.status }));
    if (response.status === 401 || response.status === 403) throw new HttpError(502, "SteamGridDB authentication failed");
    if (response.status === 404) throw new HttpError(404, "The selected game was not found.");
    throw new HttpError(response.status === 429 ? 429 : 502, "Unable to search games right now. Try again.");
  }
  const payload = await response.json().catch(() => null);
  if (!payload || payload.success === false) throw new HttpError(502, "Unable to search games right now. Try again.");
  return payload;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function resolveSteamGridDbGame(gameId, env) {
  if (!Number.isSafeInteger(gameId) || gameId <= 0) throw new HttpError(400, "Select a valid game.");
  const response = await steamGridRequest(`https://www.steamgriddb.com/api/v2/games/id/${gameId}`, env);
  const game = response.data;
  if (!game || game.id !== gameId || typeof game.name !== "string") throw new HttpError(400, "The selected game could not be verified.");
  return { id: game.id, name: cleanText(game.name, 160) };
}

async function listGames(url, env) {
  const query = cleanText(url.searchParams.get("q"), 120);
  const statement = query
    ? env.MODX_DB.prepare(
        `SELECT g.id, g.title, g.steamgriddb_id AS steamGridDbId, g.artwork_url AS artworkUrl,
                GROUP_CONCAT(ge.executable_name, '|') AS executables
         FROM games g LEFT JOIN game_executables ge ON ge.game_id = g.id
         WHERE g.normalized_title LIKE ?1
         GROUP BY g.id ORDER BY g.title LIMIT 50`,
      ).bind(`%${normalize(query)}%`)
    : env.MODX_DB.prepare(
        `SELECT g.id, g.title, g.steamgriddb_id AS steamGridDbId, g.artwork_url AS artworkUrl,
                GROUP_CONCAT(ge.executable_name, '|') AS executables
         FROM games g LEFT JOIN game_executables ge ON ge.game_id = g.id
         GROUP BY g.id ORDER BY g.title LIMIT 100`,
      );
  const { results } = await statement.all();
  return json({ games: results.map(mapGame) });
}

async function findTables(url, env) {
  const executable = normalizeExecutable(url.searchParams.get("executable"));
  const steamGridDbId = positiveInteger(url.searchParams.get("steamGridDbId"));
  const platform = cleanText(url.searchParams.get("platform"), 20) || "windows";
  if (!executable && !steamGridDbId) throw new HttpError(400, "executable or steamGridDbId is required");
  if (!PLATFORM_IDS.has(platform)) throw new HttpError(400, "Select a valid platform");

  const projection =
    `SELECT DISTINCT tr.id, tr.version, tr.original_filename AS filename, tr.sha256,
            tr.file_size AS fileSize, tr.notes, tr.contributor_name AS contributorName,
            tr.service_scope AS serviceScope,
            tr.game_executable_sha256 AS gameExecutableSha256,
            tr.game_executable_file_size AS gameExecutableFileSize,
            tr.future_service_support AS futureServiceSupport,
            tr.maintenance_policy AS maintenancePolicy,
            tr.community_readme_download_url AS communityReadmeDownloadUrl,
            tr.created_at AS createdAt, g.id AS gameId, g.title AS gameTitle,
            g.artwork_url AS artworkUrl
     FROM table_releases tr
     JOIN games g ON g.id = tr.game_id`;
  const statement = executable
    ? env.MODX_DB.prepare(
        `${projection}
         JOIN table_release_platform_executables trpe ON trpe.table_release_id = tr.id
         WHERE trpe.normalized_executable = ?1
           AND trpe.platform_id = ?2
           AND tr.status = 'published'
           AND tr.maintenance_policy = 'community'
           AND NOT EXISTS (SELECT 1 FROM blocked_games bg WHERE bg.game_id = g.id)
         ORDER BY tr.created_at DESC`,
      ).bind(executable, platform)
    : env.MODX_DB.prepare(
        `${projection}
         WHERE g.steamgriddb_id = ?1
           AND EXISTS (
             SELECT 1 FROM table_release_platform_executables trpe
             WHERE trpe.table_release_id = tr.id AND trpe.platform_id = ?2
           )
           AND tr.status = 'published'
           AND tr.maintenance_policy = 'community'
           AND NOT EXISTS (SELECT 1 FROM blocked_games bg WHERE bg.game_id = g.id)
         ORDER BY tr.created_at DESC`,
      ).bind(steamGridDbId, platform);
  const { results } = await statement.all();
  const metadataByRelease = new Map(results.map((table) => [table.id, { supportedPlatforms: [], executables: {}, services: [] }]));
  for (let offset = 0; offset < results.length; offset += 50) {
    const releases = results.slice(offset, offset + 50);
    const placeholders = releases.map((_, index) => `?${index + 1}`).join(",");
    const metadata = await env.MODX_DB.prepare(
      `SELECT table_release_id AS tableReleaseId, platform_id AS platformId, executable_name AS executableName
       FROM table_release_platform_executables
       WHERE table_release_id IN (${placeholders})
       ORDER BY table_release_id, platform_id`,
    ).bind(...releases.map((table) => table.id)).all();
    for (const row of metadata.results) {
      const release = metadataByRelease.get(row.tableReleaseId);
      if (!release) continue;
      if (!release.supportedPlatforms.includes(row.platformId)) release.supportedPlatforms.push(row.platformId);
      if (!(row.platformId in release.executables)) release.executables[row.platformId] = row.executableName;
    }
    const serviceMetadata = await env.MODX_DB.prepare(
      `SELECT table_release_id AS tableReleaseId, service_name AS serviceName
       FROM table_release_services
       WHERE table_release_id IN (${placeholders})
       ORDER BY table_release_id, service_name`,
    ).bind(...releases.map((table) => table.id)).all();
    for (const row of serviceMetadata.results) {
      const release = metadataByRelease.get(row.tableReleaseId);
      if (release && !release.services.includes(row.serviceName)) release.services.push(row.serviceName);
    }
  }
  return json({
    tables: results.map((table) => ({
      ...table,
      futureServiceSupport: Boolean(table.futureServiceSupport),
      ...metadataByRelease.get(table.id),
      status: "Published",
      usePolicy: "Offline/single-player use only",
      downloadUrl: `${url.origin}${url.pathname.replace(/\/tables$/, "")}/tables/${encodeURIComponent(table.id)}/download`,
      reportAction: "Report table",
      reportUrl: `https://vortex-prime-emu.com/api/modx/tables/${encodeURIComponent(table.id)}/report`,
      reportReasons: [
        { id: "online_or_multiplayer_cheating", label: "Online or multiplayer cheating" },
        { id: "malware_or_unsafe_code", label: "Malware or unsafe code" },
        { id: "stolen_or_misleading", label: "Stolen or misleading table" },
        { id: "other", label: "Other" },
      ],
    })),
  });
}

async function downloadTable(id, env) {
  const row = await env.MODX_DB.prepare(
    `SELECT tr.download_url AS downloadUrl, tr.original_filename AS filename
     FROM table_releases tr
     WHERE tr.id = ?1 AND tr.status = 'published'
       AND tr.maintenance_policy = 'community'
       AND NOT EXISTS (SELECT 1 FROM blocked_games bg WHERE bg.game_id = tr.game_id)`,
  ).bind(id).first();
  if (!row) throw new HttpError(404, "Table not found");
  const source = await fetch(row.downloadUrl, { signal: AbortSignal.timeout(15000) });
  if (!source.ok || !source.body) throw new HttpError(502, "The table file is temporarily unavailable");
  return new Response(source.body, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeFilename(row.filename)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function createGame(request, env) {
  const body = await readJson(request);
  const title = cleanText(body.title, 160);
  if (!title) throw new HttpError(400, "title is required");
  const steamGridDbId = Number.isInteger(body.steamGridDbId) ? body.steamGridDbId : null;
  const artworkUrl = validArtworkUrl(body.artworkUrl);
  const executables = uniqueExecutables(body.executables);
  if (!executables.length) throw new HttpError(400, "At least one game executable is required");

  const gameId = crypto.randomUUID();
  const statements = [
    env.MODX_DB.prepare(
      `INSERT INTO games (id, title, normalized_title, steamgriddb_id, artwork_url)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(gameId, title, normalize(title), steamGridDbId, artworkUrl),
    ...executables.map((executable) => env.MODX_DB.prepare(
      `INSERT INTO game_executables
       (id, game_id, executable_name, normalized_executable) VALUES (?1, ?2, ?3, ?4)`,
    ).bind(crypto.randomUUID(), gameId, executable, normalizeExecutable(executable))),
  ];
  await env.MODX_DB.batch(statements);
  return json({ id: gameId, title, steamGridDbId, artworkUrl, executables }, 201);
}

async function uploadTable(request, env) {
  const form = await request.formData();
  return uploadTableForm(form, env, "published");
}

async function submitCommunityTable(request, env) {
  const form = await request.formData();
  if (String(form.get("offlineOnlyConfirmed")).toLowerCase() !== "true") {
    throw new HttpError(400, "Confirm that this table is for offline or single-player use only.");
  }
  const uploaderAbuseKey = cleanAbuseKey(form.get("uploaderAbuseKey"));
  if (!uploaderAbuseKey) throw new HttpError(400, "Uploader abuse protection is missing.");
  const blockedUploader = await env.MODX_DB.prepare(
    "SELECT 1 AS blocked FROM abuse_blocks WHERE uploader_abuse_key = ?1",
  ).bind(uploaderAbuseKey).first();
  if (blockedUploader) throw new HttpError(403, "This account cannot publish community tables.");
  const executableMetadata = parseGameExecutableMetadata(form, true);
  const title = titleFromExecutable(executableMetadata.name);
  if (!title) throw new HttpError(400, "The game name could not be derived from the executable.");
  const serviceMetadata = parseServiceMetadata(form, true);
  const updatePolicy = parseUpdatePolicy(form, serviceMetadata.scope, true);
  const gameId = await ensureCommunityGame(env, title, executableMetadata.name);
  form.set("gameId", gameId);
  form.set("supportedPlatforms", JSON.stringify(serviceMetadata.platforms));
  form.set("executables", JSON.stringify(Object.fromEntries(
    serviceMetadata.platforms.map((platform) => [platform, executableMetadata.name]),
  )));
  form.set("serviceScope", serviceMetadata.scope);
  form.set("services", JSON.stringify(serviceMetadata.services));
  form.set("futureServiceSupport", String(updatePolicy.futureServiceSupport));
  form.set("maintenancePolicy", updatePolicy.maintenancePolicy);
  form.delete("gameTitle");
  form.delete("artworkUrl");
  form.delete("executable");
  form.delete("executableIds");
  form.delete("version");
  form.delete("notes");
  return uploadTableForm(form, env, "published");
}

async function ensureCommunityGame(env, title, executableName) {
  const normalizedTitle = normalize(title);
  const normalizedExecutable = normalizeExecutable(executableName);
  let game = await env.MODX_DB.prepare(
    `SELECT g.id
     FROM games g
     JOIN game_executables ge ON ge.game_id = g.id
     WHERE ge.normalized_executable = ?1
     ORDER BY g.created_at
     LIMIT 1`,
  ).bind(normalizedExecutable).first();
  if (game?.id) return game.id;

  game = await env.MODX_DB.prepare(
    "SELECT id FROM games WHERE normalized_title = ?1 ORDER BY created_at LIMIT 1",
  ).bind(normalizedTitle).first();
  const gameId = game?.id || crypto.randomUUID();
  const statements = [];
  if (!game) {
    statements.push(env.MODX_DB.prepare(
      `INSERT INTO games (id, title, normalized_title, steamgriddb_id, artwork_url)
       VALUES (?1, ?2, ?3, NULL, NULL)`,
    ).bind(gameId, title, normalizedTitle));
  } else {
    statements.push(env.MODX_DB.prepare(
      "UPDATE games SET title = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
    ).bind(title, gameId));
  }
  statements.push(env.MODX_DB.prepare(
    `INSERT OR IGNORE INTO game_executables
     (id, game_id, executable_name, normalized_executable) VALUES (?1, ?2, ?3, ?4)`,
  ).bind(crypto.randomUUID(), gameId, executableName, normalizedExecutable));
  await env.MODX_DB.batch(statements);
  return gameId;
}

async function uploadTableForm(form, env, status) {
  const gameId = cleanText(form.get("gameId"), 80);
  const requestedVersion = cleanText(form.get("version"), 60);
  const notes = cleanText(form.get("notes"), 2000);
  const contributorName = cleanText(form.get("contributorName"), 100);
  const offlineOnlyConfirmed = String(form.get("offlineOnlyConfirmed")).toLowerCase() === "true";
  const uploaderAbuseKey = cleanAbuseKey(form.get("uploaderAbuseKey"));
  const file = form.get("file");
  if (!gameId) throw new HttpError(400, "gameId is required");
  if (!(file instanceof File)) throw new HttpError(400, "A .CT file is required");
  if (!file.name.toLowerCase().endsWith(".ct")) throw new HttpError(400, "Only .CT files are accepted");
  if (!file.size) throw new HttpError(400, "The selected .CT file is empty");
  if (!offlineOnlyConfirmed) throw new HttpError(400, "Confirm that this table is for offline or single-player use only.");

  const platformMetadata = parsePlatformMetadata(form);
  const serviceMetadata = parseServiceMetadata(form, false);
  const executableMetadata = parseGameExecutableMetadata(form, false);
  const updatePolicy = parseUpdatePolicy(form, serviceMetadata.scope, false);
  const communityReadme = await readCommunityReadme(form, updatePolicy.maintenancePolicy);
  const executableIds = parseIdList(form.get("executableIds"));
  const game = await env.MODX_DB.prepare("SELECT id FROM games WHERE id = ?1").bind(gameId).first();
  if (!game) throw new HttpError(404, "Game not found");
  const blockedGame = await env.MODX_DB.prepare(
    "SELECT reason FROM blocked_games WHERE game_id = ?1",
  ).bind(gameId).first();
  if (blockedGame) throw new HttpError(403, "Community tables are blocked for this game.");

  if (executableIds.length) {
    const placeholders = executableIds.map((_, index) => `?${index + 2}`).join(",");
    const matching = await env.MODX_DB.prepare(
      `SELECT id FROM game_executables WHERE game_id = ?1 AND id IN (${placeholders})`,
    ).bind(gameId, ...executableIds).all();
    if (matching.results.length !== executableIds.length) throw new HttpError(400, "An executable does not belong to this game");
  }

  const releaseCount = await env.MODX_DB.prepare("SELECT COUNT(*) AS count FROM table_releases WHERE game_id = ?1").bind(gameId).first();
  const version = requestedVersion || `Revision ${Number(releaseCount?.count || 0) + 1}`;

  const bytes = await file.arrayBuffer();
  const scanResult = validateCheatTable(bytes);
  const sha256 = toHex(await crypto.subtle.digest("SHA-256", bytes));
  const releaseId = crypto.randomUUID();
  const githubPath = `tables/${gameId}/${releaseId}.ct`;
  const githubFile = await createGitHubFile(env, {
    path: githubPath,
    bytes,
    message: `Add ModX table for ${gameId} (${version})`,
  });
  const communityReadmePath = communityReadme ? `tables/${gameId}/${releaseId}/README.md` : null;
  let communityReadmeFile = null;
  if (communityReadme) {
    try {
      communityReadmeFile = await createGitHubFile(env, {
        path: communityReadmePath,
        bytes: communityReadme.bytes,
        message: `Add community README for ${gameId} (${version})`,
      });
    } catch (error) {
      await deleteGitHubFile(env, githubPath, githubFile.sha, `Rollback failed ModX upload ${releaseId}`);
      throw error;
    }
  }

  try {
    await env.MODX_DB.batch([
      env.MODX_DB.prepare(
         `INSERT INTO table_releases
         (id, game_id, version, object_key, github_owner, github_repo, github_branch, github_path,
          github_blob_sha, download_url, original_filename, sha256, file_size, notes,
           contributor_name, status, offline_only_confirmed, uploader_abuse_key,
           service_scope, game_executable_sha256, game_executable_file_size,
           future_service_support, maintenance_policy,
           community_readme_path, community_readme_sha, community_readme_download_url,
           scan_status, scan_result_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, 'passed', ?27)`,
      ).bind(
        releaseId, gameId, version, githubPath, env.GITHUB_OWNER, env.GITHUB_REPO,
        env.GITHUB_BRANCH || "main", githubPath, githubFile.sha,
        githubFile.downloadUrl, safeFilename(file.name), sha256, file.size,
         notes, contributorName, status, 1, uploaderAbuseKey,
         serviceMetadata.scope, executableMetadata?.sha256 || null, executableMetadata?.size || null,
         updatePolicy.futureServiceSupport ? 1 : 0, updatePolicy.maintenancePolicy,
         communityReadmePath, communityReadmeFile?.sha || null, communityReadmeFile?.downloadUrl || null,
         JSON.stringify(scanResult),
      ),
      ...executableIds.map((executableId) => env.MODX_DB.prepare(
        `INSERT INTO table_release_executables (table_release_id, game_executable_id) VALUES (?1, ?2)`,
      ).bind(releaseId, executableId)),
      ...platformMetadata.supportedPlatforms.map((platformId) => env.MODX_DB.prepare(
        `INSERT INTO table_release_platform_executables
         (table_release_id, platform_id, executable_name, normalized_executable)
         VALUES (?1, ?2, ?3, ?4)`,
      ).bind(
        releaseId,
        platformId,
        platformMetadata.executables[platformId],
        normalizeExecutable(platformMetadata.executables[platformId]),
      )),
      ...serviceMetadata.services.map((serviceName) => env.MODX_DB.prepare(
        `INSERT INTO table_release_services
         (table_release_id, service_name, normalized_service) VALUES (?1, ?2, ?3)`,
      ).bind(releaseId, serviceName, normalizeService(serviceName))),
      env.MODX_DB.prepare(
        `INSERT INTO audit_events (id, event_type, entity_id, metadata_json)
         VALUES (?1, 'table.uploaded', ?2, ?3)`,
      ).bind(crypto.randomUUID(), releaseId, JSON.stringify({
        gameId,
        sha256,
        supportedPlatforms: platformMetadata.supportedPlatforms,
        executables: platformMetadata.executables,
        serviceScope: serviceMetadata.scope,
        services: serviceMetadata.services,
        gameExecutableSha256: executableMetadata?.sha256 || null,
        gameExecutableFileSize: executableMetadata?.size || null,
        futureServiceSupport: updatePolicy.futureServiceSupport,
        maintenancePolicy: updatePolicy.maintenancePolicy,
        communityReadmePath,
      })),
    ]);
  } catch (error) {
    if (communityReadmeFile) await deleteGitHubFile(env, communityReadmePath, communityReadmeFile.sha, `Rollback failed ModX README ${releaseId}`);
    await deleteGitHubFile(env, githubPath, githubFile.sha, `Rollback failed ModX upload ${releaseId}`);
    throw error;
  }
  return json({
    id: releaseId,
    gameId,
    version,
    sha256,
    fileSize: file.size,
    status,
    supportedPlatforms: platformMetadata.supportedPlatforms,
    executables: platformMetadata.executables,
    serviceScope: serviceMetadata.scope,
    services: serviceMetadata.services,
    gameExecutableSha256: executableMetadata?.sha256 || null,
    gameExecutableFileSize: executableMetadata?.size || null,
    futureServiceSupport: updatePolicy.futureServiceSupport,
    maintenancePolicy: updatePolicy.maintenancePolicy,
    listedInCommunity: updatePolicy.maintenancePolicy === "community",
    communityReadmePath,
    communityReadmeDownloadUrl: communityReadmeFile?.downloadUrl || null,
    usePolicy: "Offline/single-player use only",
    scanStatus: "passed",
    githubPath,
  }, 201);
}

async function createGitHubFile(env, { path, bytes, message }) {
  requireGitHubConfiguration(env);
  const branch = env.GITHUB_BRANCH || "main";
  const response = await fetch(githubContentsUrl(env, path), {
    method: "PUT",
    headers: githubHeaders(env),
    body: JSON.stringify({ message, content: arrayBufferToBase64(bytes), branch }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("GitHub upload failed", { status: response.status, message: payload.message });
    throw new HttpError(502, "GitHub rejected the cheat table upload");
  }
  const sha = payload.content?.sha;
  const downloadUrl = payload.content?.download_url || rawGitHubUrl(env, path);
  if (!sha) throw new HttpError(502, "GitHub did not return the uploaded file details");
  return { sha, downloadUrl };
}

async function deleteGitHubFile(env, path, sha, message) {
  const response = await fetch(githubContentsUrl(env, path), {
    method: "DELETE",
    headers: githubHeaders(env),
    body: JSON.stringify({ message, sha, branch: env.GITHUB_BRANCH || "main" }),
  });
  if (!response.ok) console.error("GitHub rollback failed", { path, status: response.status });
}

async function removeGitHubFile(env, path, sha, message) {
  requireGitHubConfiguration(env);
  const response = await fetch(githubContentsUrl(env, path), {
    method: "DELETE",
    headers: githubHeaders(env),
    body: JSON.stringify({ message, sha, branch: env.GITHUB_BRANCH || "main" }),
  });
  if (response.status === 404) return;
  if (!response.ok) {
    console.error(JSON.stringify({ event: "modx.github.delete_failed", status: response.status, path }));
    throw new HttpError(502, "GitHub could not remove the table file");
  }
}

function requireGitHubConfiguration(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
    throw new HttpError(503, "GitHub table storage is not configured");
  }
}

function githubContentsUrl(env, path) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/contents/${encodedPath}`;
}

function rawGitHubUrl(env, path) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/${encodeURIComponent(env.GITHUB_BRANCH || "main")}/${encodedPath}`;
}

function githubHeaders(env) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ModX-Community-Tables",
    "Content-Type": "application/json",
  };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function reportCommunityTable(request, id, env) {
  const body = await readJson(request);
  const reporterAbuseKey = cleanAbuseKey(body.reporterAbuseKey);
  if (!reporterAbuseKey) throw new HttpError(400, "Reporter abuse protection is missing.");
  const reasons = new Set([
    "online_or_multiplayer_cheating",
    "malware_or_unsafe_code",
    "stolen_or_misleading",
    "other",
  ]);
  if (!reasons.has(body.reason)) throw new HttpError(400, "Select a valid report reason.");
  const table = await env.MODX_DB.prepare(
    `SELECT tr.id FROM table_releases tr
     WHERE tr.id = ?1 AND tr.status = 'published'
       AND tr.maintenance_policy = 'community'
       AND NOT EXISTS (SELECT 1 FROM blocked_games bg WHERE bg.game_id = tr.game_id)`,
  ).bind(id).first();
  if (!table) throw new HttpError(404, "Table not found");

  const reportId = crypto.randomUUID();
  const result = await env.MODX_DB.prepare(
    `INSERT OR IGNORE INTO table_reports
     (id, table_release_id, reporter_abuse_key, reason, details)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(reportId, id, reporterAbuseKey, body.reason, cleanText(body.details, 1000)).run();
  if (result.meta.changes) {
    await env.MODX_DB.prepare(
      `INSERT INTO audit_events (id, event_type, entity_id, metadata_json)
       VALUES (?1, 'table.reported', ?2, ?3)`,
    ).bind(crypto.randomUUID(), id, JSON.stringify({ reason: body.reason })).run();
  }
  return json({ ok: true, reportId: result.meta.changes ? reportId : null }, 201);
}

async function takeDownTable(request, id, env) {
  const body = await readJson(request);
  const reason = cleanText(body.reason, 500);
  if (!reason) throw new HttpError(400, "A takedown reason is required.");
  const table = await env.MODX_DB.prepare(
    `SELECT id, github_path AS githubPath, github_blob_sha AS githubBlobSha,
            community_readme_path AS communityReadmePath, community_readme_sha AS communityReadmeSha, status
     FROM table_releases WHERE id = ?1`,
  ).bind(id).first();
  if (!table) throw new HttpError(404, "Table not found");
  if (table.githubPath && table.githubBlobSha) {
    await removeGitHubFile(env, table.githubPath, table.githubBlobSha, `Take down ModX table ${id}`);
  }
  if (table.communityReadmePath && table.communityReadmeSha) {
    await removeGitHubFile(env, table.communityReadmePath, table.communityReadmeSha, `Take down ModX README ${id}`);
  }
  await env.MODX_DB.batch([
    env.MODX_DB.prepare(
      `UPDATE table_releases
       SET status = 'taken_down', download_url = NULL, community_readme_download_url = NULL, takedown_reason = ?1,
           taken_down_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?2`,
    ).bind(reason, id),
    env.MODX_DB.prepare(
      `INSERT INTO audit_events (id, event_type, entity_id, metadata_json)
       VALUES (?1, 'table.taken_down', ?2, ?3)`,
    ).bind(crypto.randomUUID(), id, JSON.stringify({ reason })),
  ]);
  return json({ id, status: "taken_down", action: "Take down immediately" });
}

async function blockGame(request, gameId, env) {
  const body = await readJson(request);
  const reason = cleanText(body.reason, 500);
  if (!reason) throw new HttpError(400, "A block reason is required.");
  const game = await env.MODX_DB.prepare("SELECT id, title FROM games WHERE id = ?1").bind(gameId).first();
  if (!game) throw new HttpError(404, "Game not found");

  await env.MODX_DB.prepare(
    `INSERT INTO blocked_games (game_id, reason) VALUES (?1, ?2)
     ON CONFLICT(game_id) DO UPDATE SET reason = excluded.reason, updated_at = CURRENT_TIMESTAMP`,
  ).bind(gameId, reason).run();

  const { results } = await env.MODX_DB.prepare(
    `SELECT id, github_path AS githubPath, github_blob_sha AS githubBlobSha,
            community_readme_path AS communityReadmePath, community_readme_sha AS communityReadmeSha
     FROM table_releases WHERE game_id = ?1 AND status = 'published'`,
  ).bind(gameId).all();
  const deletionFailures = [];
  for (const table of results) {
    if (!table.githubPath || !table.githubBlobSha) continue;
    try {
      await removeGitHubFile(env, table.githubPath, table.githubBlobSha, `Block ModX tables for ${game.title}`);
      if (table.communityReadmePath && table.communityReadmeSha) {
        await removeGitHubFile(env, table.communityReadmePath, table.communityReadmeSha, `Block ModX README for ${game.title}`);
      }
    } catch (error) {
      deletionFailures.push(table.id);
      console.error(JSON.stringify({ event: "modx.game_block.github_delete_failed", gameId, tableId: table.id }));
    }
  }
  await env.MODX_DB.batch([
    env.MODX_DB.prepare(
      `UPDATE table_releases
       SET status = 'taken_down', download_url = NULL, community_readme_download_url = NULL, takedown_reason = ?1,
           taken_down_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE game_id = ?2 AND status = 'published'`,
    ).bind(`Game blocked: ${reason}`, gameId),
    env.MODX_DB.prepare(
      `INSERT INTO audit_events (id, event_type, entity_id, metadata_json)
       VALUES (?1, 'game.blocked', ?2, ?3)`,
    ).bind(crypto.randomUUID(), gameId, JSON.stringify({ reason, hiddenTableCount: results.length })),
  ]);
  return json({ gameId, blocked: true, hiddenTableCount: results.length, deletionFailures });
}

async function unblockGame(gameId, env) {
  const result = await env.MODX_DB.prepare("DELETE FROM blocked_games WHERE game_id = ?1").bind(gameId).run();
  if (!result.meta.changes) throw new HttpError(404, "Blocked game not found");
  return json({ gameId, blocked: false });
}

async function blockUploader(request, uploaderAbuseKey, env) {
  const body = await readJson(request);
  const reason = cleanText(body.reason, 500);
  if (!reason) throw new HttpError(400, "A block reason is required.");
  await env.MODX_DB.prepare(
    `INSERT INTO abuse_blocks (uploader_abuse_key, reason) VALUES (?1, ?2)
     ON CONFLICT(uploader_abuse_key) DO UPDATE SET reason = excluded.reason`,
  ).bind(uploaderAbuseKey, reason).run();
  return json({ blocked: true });
}

function requireAdmin(request, env) {
  if (!env.MODX_ADMIN_TOKEN) throw new HttpError(503, "Administration is not configured");
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!constantTimeEqual(supplied, env.MODX_ADMIN_TOKEN)) throw new HttpError(401, "Unauthorized");
}

function requireBridge(request, env) {
  if (!env.MODX_BRIDGE_TOKEN) throw new HttpError(503, "Website upload bridge is not configured");
  const supplied = request.headers.get("X-ModX-Bridge") || "";
  if (!constantTimeEqual(supplied, env.MODX_BRIDGE_TOKEN)) throw new HttpError(401, "Unauthorized");
}

function constantTimeEqual(left, right) {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) mismatch |= (a[i % (a.length || 1)] || 0) ^ (b[i % (b.length || 1)] || 0);
  return mismatch === 0;
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  }
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

async function readJson(request) {
  if (!request.headers.get("Content-Type")?.includes("application/json")) throw new HttpError(415, "JSON is required");
  try { return await request.json(); } catch { throw new HttpError(400, "Invalid JSON"); }
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function titleFromExecutable(name) {
  return name
    .replace(/\.exe$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function normalizeService(value) {
  return normalize(value);
}

function parseServiceMetadata(form, required) {
  const rawScope = String(form.get("serviceScope") || "").trim().toLowerCase();
  const rawServices = String(form.get("services") || "").trim();
  if (!required && !rawScope && !rawServices) return { scope: "single", services: [], platforms: [] };
  if (rawScope !== "single" && rawScope !== "multiple") {
    throw new HttpError(400, "Choose whether the table supports one service or multiple services");
  }
  let services;
  try {
    services = JSON.parse(rawServices);
  } catch {
    throw new HttpError(400, "Service compatibility information is invalid");
  }
  if (!Array.isArray(services) || services.length < 1 || services.length > 12) {
    throw new HttpError(400, "Enter the supported game service or services");
  }
  const unique = new Map();
  const platforms = new Set();
  for (const value of services) {
    const name = cleanText(value, 80).replace(/\s+/g, " ");
    const platformMatch = /^(win|linux)\s*\/\s*(.+)$/i.exec(name);
    const normalized = normalizeService(name);
    if (!name || !normalized || /[\u0000-\u001f]/.test(name)) throw new HttpError(400, "Each supported service must have a valid name");
    if (!platformMatch || !platformMatch[2].trim()) {
      throw new HttpError(400, "Use WIN/Service or Linux/Service for every supported service");
    }
    platforms.add(platformMatch[1].toLowerCase() === "win" ? "windows" : "linux");
    unique.set(normalized, name);
  }
  const names = [...unique.values()];
  if (rawScope === "single" && names.length !== 1) throw new HttpError(400, "Enter exactly one supported service");
  if (rawScope === "multiple" && names.length < 2) throw new HttpError(400, "Enter at least two supported services");
  return { scope: rawScope, services: names, platforms: [...platforms] };
}

function parseGameExecutableMetadata(form, required) {
  const name = safeExecutableIdentifier(form.get("gameExecutableName"));
  const rawSize = String(form.get("gameExecutableSize") || "").trim();
  const sha256 = String(form.get("gameExecutableSha256") || "").trim().toLowerCase();
  if (!required && !name && !rawSize && !sha256) return null;
  const size = Number(rawSize);
  if (!name || !name.toLowerCase().endsWith(".exe")) throw new HttpError(400, "Choose a valid Windows game .exe file");
  if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, "The game executable size is invalid");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new HttpError(400, "The game executable verification data is invalid");
  return { name, size, sha256 };
}

function parseUpdatePolicy(form, serviceScope, required) {
  const futureValue = String(form.get("futureServiceSupport") || "").trim().toLowerCase();
  const maintenancePolicy = String(form.get("maintenancePolicy") || "").trim().toLowerCase();
  if (!required && !futureValue && !maintenancePolicy) {
    return { futureServiceSupport: false, maintenancePolicy: "uploader" };
  }
  if (futureValue !== "true" && futureValue !== "false") {
    throw new HttpError(400, "Choose whether support for more services is planned");
  }
  if (maintenancePolicy !== "uploader" && maintenancePolicy !== "community") {
    throw new HttpError(400, "Choose how future table updates should be handled");
  }
  return {
    futureServiceSupport: serviceScope === "single" && futureValue === "true",
    maintenancePolicy,
  };
}

const COMMUNITY_README_FIELDS = ["Game Name", "Author", "Version", "Game.exe", "Platform service/Cross-platform", "Credits"];

function missingCommunityReadmeFields(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  const headings = COMMUNITY_README_FIELDS.map((label) => ({
    label,
    index: lines.findIndex((line) => {
      const value = line.trim().toLowerCase();
      const target = label.toLowerCase();
      return value === target || value.startsWith(`${target}:`);
    }),
  }));
  return headings.filter((heading, position) => {
    if (heading.index < 0) return true;
    const sameLine = lines[heading.index].trim().slice(heading.label.length).replace(/^:\s*/, "").trim();
    if (sameLine) return false;
    const later = headings.slice(position + 1).map((item) => item.index).filter((index) => index > heading.index);
    const end = later.length ? Math.min(...later) : lines.length;
    return !lines.slice(heading.index + 1, end).map((line) => line.trim()).filter((line) => line && !line.startsWith(">")).join(" ");
  }).map((heading) => heading.label);
}

async function readCommunityReadme(form, maintenancePolicy) {
  if (maintenancePolicy !== "community") return null;
  const readme = form.get("readme");
  if (!(readme instanceof File) || readme.name.toLowerCase() !== "readme.md") {
    throw new HttpError(400, "Upload the completed README.md before publishing a community-maintained table.");
  }
  if (!readme.size || readme.size > 512 * 1024) {
    throw new HttpError(400, "README.md must contain your completed details and be smaller than 512 KB.");
  }
  const bytes = await readme.arrayBuffer();
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const missing = missingCommunityReadmeFields(text);
  if (missing.length) throw new HttpError(400, `Complete these README sections: ${missing.join(", ")}.`);
  return { bytes };
}

function parsePlatformMetadata(form) {
  let supportedPlatforms;
  let executables;
  try {
    supportedPlatforms = JSON.parse(String(form.get("supportedPlatforms") || ""));
    executables = JSON.parse(String(form.get("executables") || ""));
  } catch {
    throw new HttpError(400, "Platform compatibility metadata is invalid");
  }
  if (!Array.isArray(supportedPlatforms) || !supportedPlatforms.length || supportedPlatforms.length > PLATFORM_DEFINITIONS.length) {
    throw new HttpError(400, "Choose at least one supported platform");
  }
  const platforms = [...new Set(supportedPlatforms)];
  if (platforms.length !== supportedPlatforms.length || platforms.some((platform) => typeof platform !== "string" || !PLATFORM_IDS.has(platform))) {
    throw new HttpError(400, "A selected platform is invalid");
  }
  if (!executables || typeof executables !== "object" || Array.isArray(executables)) {
    throw new HttpError(400, "Game executable metadata is invalid");
  }
  if (Object.keys(executables).some((platform) => !PLATFORM_IDS.has(platform) || !platforms.includes(platform))) {
    throw new HttpError(400, "Executable metadata contains an unselected platform");
  }
  const sanitizedExecutables = {};
  for (const platform of platforms) {
    const filename = safeExecutableIdentifier(executables[platform]);
    if (!filename) throw new HttpError(400, `The ${platform} game-file identifier is invalid`);
    if (platform === "windows" && !filename.toLowerCase().endsWith(".exe")) {
      throw new HttpError(400, "Select a Windows .exe game file");
    }
    sanitizedExecutables[platform] = filename;
  }
  return { supportedPlatforms: platforms, executables: sanitizedExecutables };
}

function safeExecutableIdentifier(value) {
  if (typeof value !== "string") return "";
  const filename = value.trim();
  if (!filename || filename.length > 260 || filename === "." || filename === "..") return "";
  if (/[\\/\u0000-\u001f]/.test(filename)) return "";
  return filename;
}

function normalizeExecutable(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^.*[\\/]/, "").toLowerCase();
}

function uniqueExecutables(value) {
  if (!Array.isArray(value)) return [];
  const byNormalizedName = new Map();
  for (const item of value) {
    const name = cleanText(item, 260).replace(/^.*[\\/]/, "");
    const normalized = normalizeExecutable(name);
    if (normalized.endsWith(".exe")) byNormalizedName.set(normalized, name);
  }
  return [...byNormalizedName.values()];
}

function parseIdList(value) {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))].slice(0, 20);
}

function validArtworkUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error();
    return url.toString().slice(0, 1000);
  } catch { throw new HttpError(400, "artworkUrl must be a valid HTTPS URL"); }
}

function safeFilename(value) {
  return String(value || "table.ct").replace(/[\r\n"\\/]/g, "_").slice(0, 180);
}

function cleanAbuseKey(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

function validateCheatTable(buffer) {
  const bytes = new Uint8Array(buffer);
  const sample = bytes.subarray(0, Math.min(bytes.length, 512 * 1024));
  if (sample.includes(0)) throw new HttpError(400, "The .CT file is not valid text/XML.");
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "");
  if (!/<CheatTable(?:\s|>)/i.test(text) || !/<\/CheatTable\s*>/i.test(text)) {
    throw new HttpError(400, "The file is not a valid cheat table.");
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    throw new HttpError(400, "External XML declarations are not allowed in community tables.");
  }
  const blockedPrimitives = [
    /\bos\.execute\s*\(/i,
    /\bio\.popen\s*\(/i,
    /\bshellExecute(?:Ex)?\s*\(/i,
    /\bcreateProcess\s*\(/i,
    /\bgetInternet\s*\(/i,
  ];
  if (blockedPrimitives.some((pattern) => pattern.test(text))) {
    throw new HttpError(400, "The table contains a blocked system or network execution primitive.");
  }
  return {
    schema: "cheat-engine-ct",
    xmlEnvelope: "passed",
    externalEntities: "none",
    blockedPrimitives: "none",
    containsLua: /<LuaScript>|<LuaScriptEntry>/i.test(text),
    containsAutoAssembler: /<AssemblerScript>/i.test(text),
  };
}

function mapGame(row) {
  return { ...row, executables: row.executables ? row.executables.split("|") : [] };
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
