import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  checkForSyncoraUpdate,
  compareVersions,
  inferUpdateCommand,
} from "../../skills/syncora/scripts/lib/update-status.mjs";
import {
  VERSION,
  helpText,
  parseArgv,
  renderResult,
} from "../../skills/syncora/scripts/lib/cli.mjs";

function releaseResponse(version) {
  const bytes = new TextEncoder().encode(JSON.stringify({ version }));
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(bytes.byteLength) },
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test("semantic version comparison handles preview releases", () => {
  assert.equal(compareVersions("0.1.0-preview.2", "0.1.0-preview.3"), -1);
  assert.equal(compareVersions("0.1.0-preview.3", "0.1.0-preview.3"), 0);
  assert.equal(compareVersions("0.1.0", "0.1.0-preview.99"), 1);
  assert.equal(compareVersions("invalid", "0.1.0"), null);
});

test("update-status reports an available release without mutating", async () => {
  const latest = "0.1.0-preview.4";
  const projectRoot = resolve("project");
  const result = await checkForSyncoraUpdate({
    fetchImpl: async () => releaseResponse(latest),
    skillRoot: join(projectRoot, ".agents", "skills", "syncora"),
    currentDirectory: join(projectRoot, "src", "nested"),
  });

  assert.equal(result.state, "outdated");
  assert.equal(result.currentVersion, VERSION);
  assert.equal(result.latestVersion, latest);
  assert.equal(result.automaticUpdate, false);
  assert.equal(result.notificationRequired, true);
  assert.equal(result.update.command, "npx skills update syncora");
  assert.match(renderResult(result), /SYNCORA_UPDATE_AVAILABLE/u);
  assert.match(renderResult(result), /npx skills update syncora/u);
});

test("update-status is quiet when current and fail-open when unavailable", async () => {
  const current = await checkForSyncoraUpdate({
    fetchImpl: async () => releaseResponse(VERSION),
  });
  assert.equal(current.state, "current");
  assert.equal(current.notificationRequired, false);
  assert.equal(current.warning, null);

  const unavailable = await checkForSyncoraUpdate({
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(unavailable.ok, true);
  assert.equal(unavailable.state, "unknown");
  assert.equal(unavailable.notificationRequired, true);
  assert.match(unavailable.warning.message, /Could not verify/u);
});

test("update-status bounds streamed release metadata", async () => {
  const oversized = await checkForSyncoraUpdate({
    fetchImpl: async () => new Response("x".repeat(32_769)),
  });
  assert.equal(oversized.state, "unknown");
  assert.match(oversized.warning.message, /oversized/u);
});

test("update-status has no workspace, update, or suppression option", () => {
  assert.equal(parseArgv(["update-status"]).command, "update-status");
  assert.equal(
    parseArgv(["update-status", "--format", "json"]).options.format,
    "json",
  );
  assert.throws(
    () => parseArgv(["update-status", "--no-cache"]),
    /not valid with this workspace-free read-only command/u,
  );
  assert.match(helpText(), /update-status\s+Check for a newer release/u);
  assert.match(helpText("update-status"), /no auto-update or suppression option/u);
});

test("global or shared installs receive the explicit global update command", () => {
  const currentDirectory = resolve("project");
  const skillRoot = join(resolve("home"), ".agents", "skills", "syncora");
  const update = inferUpdateCommand({ skillRoot, currentDirectory });
  assert.equal(update.installationScope, "global-or-shared");
  assert.equal(update.command, "npx skills update syncora --global");
});
