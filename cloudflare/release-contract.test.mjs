import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { parseGitHubSource, selectCtAsset, verifyGitHubRelease } from "./src/index.js";
import { parseCheatTable, classifyDeterministicIntent, combineDecision } from "./src/review-worker.js";

assert.equal(typeof worker.scheduled, "function", "automatic release refresh scheduler is missing");
const wranglerConfig = JSON.parse((await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8"))
  .replace(/^\s*\/\/.*$/gm, ""));
assert.deepEqual(wranglerConfig.triggers?.crons, ["0 * * * *"]);
assert.equal(wranglerConfig.queues?.producers?.[0]?.binding, "SUBMISSION_REVIEW_QUEUE");
const reviewConfig = JSON.parse((await readFile(new URL("./wrangler.review.jsonc", import.meta.url), "utf8"))
  .replace(/^\s*\/\/.*$/gm, ""));
assert.equal(reviewConfig.queues?.consumers?.[0]?.queue, "modx-submission-reviews");
assert.equal(reviewConfig.ai?.binding, "AI");

const release = parseGitHubSource({
  provider: "github",
  url: "https://github.com/Example-Owner/game-table/releases/tag/v1.2.0",
});

assert.deepEqual(release, {
  provider: "github",
  url: "https://github.com/Example-Owner/game-table/releases/tag/v1.2.0",
  releaseUrl: "https://github.com/Example-Owner/game-table/releases/tag/v1.2.0",
  repositoryUrl: "https://github.com/Example-Owner/game-table",
  owner: "Example-Owner",
  repository: "game-table",
  tag: "v1.2.0",
  version: "v1.2.0",
});

for (const rejected of [
  "https://github.com/example/table",
  "https://github.com/example/table/releases",
  "https://github.com/example/table/blob/main/Table.ct",
  "http://github.com/example/table/releases/tag/v1.0.0",
  "https://github.com.evil.example/example/table/releases/tag/v1.0.0",
  "https://localhost/example/table/releases/tag/v1.0.0",
  "https://127.0.0.1/example/table/releases/tag/v1.0.0",
  "javascript:alert(1)",
  "not a URL",
]) {
  assert.throws(() => parseGitHubSource({ provider: "github", url: rejected }), { status: 400 }, rejected);
}

const assets = [
  { id: "1", name: "One.ct" },
  { id: "2", name: "Two.CT" },
];
assert.deepEqual(selectCtAsset([assets[0]], "", ""), assets[0]);
assert.deepEqual(selectCtAsset(assets, "2", ""), assets[1]);
assert.deepEqual(selectCtAsset(assets, "", "one.ct"), assets[0]);
assert.equal(selectCtAsset(assets, "", ""), null);
assert.equal(selectCtAsset(assets, "missing", ""), null);

const originalFetch = globalThis.fetch;
const requestedUrls = [];
globalThis.fetch = async (url) => {
  requestedUrls.push(String(url));
  if (String(url).endsWith("/repos/Example-Owner/game-table")) {
    return Response.json({ private: false, visibility: "public" });
  }
  if (String(url).includes("/releases/tags/v1.2.0")) {
    return Response.json({
      id: 123,
      draft: false,
      tag_name: "v1.2.0",
      published_at: "2026-09-16T00:00:00Z",
      assets: [{
        id: 456,
        name: "GameTable.ct",
        state: "uploaded",
        browser_download_url: "https://github.com/Example-Owner/game-table/releases/download/v1.2.0/GameTable.ct",
        size: 2048,
        digest: "sha256:" + "a".repeat(64),
      }],
    });
  }
  if (String(url).includes("/commits/v1.2.0")) {
    return Response.json({ sha: "b".repeat(40) });
  }
  return Response.json({ message: "Not Found" }, { status: 404 });
};
try {
  const verified = await verifyGitHubRelease(release, {}, null, true);
  assert.equal(verified.tag, "v1.2.0");
  assert.equal(verified.asset.name, "GameTable.ct");
  assert.equal(verified.assetDigest, "a".repeat(64));
  assert.equal(requestedUrls.length, 3);
  assert.equal(requestedUrls.every((url) => url.startsWith("https://api.github.com/repos/")), true);

  await assert.rejects(
    verifyGitHubRelease({ ...release, repository: "fabricated" }, {}, null, true),
    { status: 400 },
  );
} finally {
  globalThis.fetch = originalFetch;
}

const safeCt = new TextEncoder().encode(`<?xml version="1.0"?><CheatTable CheatEngineTableVersion="45">
  <CheatEntries><CheatEntry><ID>1</ID><Description>Infinite health (offline only)</Description>
  <VariableType>Auto Assembler Script</VariableType><AssemblerScript>[ENABLE]\naobscanmodule(health,Game.exe,90 90)\n[DISABLE]</AssemblerScript>
  </CheatEntry></CheatEntries><ProcessName>Game.exe</ProcessName><Comments>Do not use this table online.</Comments></CheatTable>`);
const parsedCt = parseCheatTable(safeCt, "Game.exe");
assert.equal(parsedCt.entryCount, 1);
assert.deepEqual(parsedCt.processNames, ["Game.exe"]);
assert.equal(parsedCt.processMismatch, false);
assert.equal(parsedCt.containsAutoAssembler, true);
assert.throws(() => parseCheatTable(new TextEncoder().encode("<!DOCTYPE x><CheatTable><CheatEntries></CheatEntries></CheatTable>")), /External XML/);
assert.equal(classifyDeterministicIntent("Do not use this trainer online. Offline only.").decision, "review");
assert.equal(classifyDeterministicIntent("Competitive ranked multiplayer aimbot cheat for public lobbies").decision, "reject");
assert.equal(combineDecision({ gameEligible: true, forcedDecision: null,
  deterministic: { decision: "review", confidence: 0.5, reasons: [], flags: [] },
  aiResult: { decision: "pass", confidence: 0.94, reasons: ["Offline intent is explicit."], flags: [] } }).decision, "pass");
assert.equal(combineDecision({ gameEligible: false, forcedDecision: null,
  deterministic: { decision: "review", confidence: 0.5, reasons: [], flags: [] },
  aiResult: { decision: "pass", confidence: 0.94, reasons: ["Offline intent is explicit."], flags: [] } }).decision, "review");

console.log("ModX GitHub Release and submission review contract tests passed.");
