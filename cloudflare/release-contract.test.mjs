import assert from "node:assert/strict";
import { parseGitHubSource, selectCtAsset, verifyGitHubRelease } from "./src/index.js";

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

console.log("ModX GitHub Release contract test passed.");
