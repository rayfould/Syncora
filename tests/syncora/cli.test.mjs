import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  helpText,
  parseArgv,
  SyncoraError,
} from "../../skills/syncora/scripts/lib/cli.mjs";

test("adopt accepts one content-addressed reviewed bundle", () => {
  const workspace = resolve("workspace");
  const bundle = resolve("review", "adoption-bundle-v1.json");
  const parsed = parseArgv([
    "adopt",
    "--workspace",
    workspace,
    "--bundle",
    bundle,
  ]);
  assert.equal(parsed.command, "adopt");
  assert.equal(parsed.options.bundle, bundle);
  assert.equal(parsed.options.migrationId, undefined);
  assert.equal(parsed.options.dryRun, false);
});

test("adopt rejects low-level artifacts and dry-run orchestration", () => {
  const workspace = resolve("workspace");
  const bundle = resolve("review", "adoption-bundle-v1.json");
  assert.throws(
    () => parseArgv([
      "adopt",
      "--workspace",
      workspace,
      "--bundle",
      bundle,
      "--manifest",
      resolve("manifest.json"),
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI005",
  );
  assert.throws(
    () => parseArgv([
      "adopt",
      "--workspace",
      workspace,
      "--bundle",
      bundle,
      "--dry-run",
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI005",
  );
});

test("bundle accepts the complete reviewed-pack input in one command", () => {
  const workspace = resolve("workspace");
  const review = resolve("review");
  const parsed = parseArgv([
    "bundle",
    "--workspace",
    workspace,
    "--migration-id",
    "legacy-adoption",
    "--manifest",
    resolve(review, "manifest.json"),
    "--staged-content",
    resolve(review, "staged-content"),
    "--fixtures",
    resolve(review, "fixtures.json"),
    "--output",
    resolve(review, "adoption-bundle-v1.json"),
    "--dry-run",
  ]);
  assert.equal(parsed.command, "bundle");
  assert.equal(parsed.options.migrationId, "legacy-adoption");
  assert.equal(parsed.options.dryRun, true);
  assert.equal(parsed.options.output, resolve(review, "adoption-bundle-v1.json"));
});

test("bundle requires every reviewed-pack input and owns --output", () => {
  const workspace = resolve("workspace");
  assert.throws(
    () => parseArgv(["bundle", "--workspace", workspace]),
    (error) =>
      error instanceof SyncoraError &&
      error.code === "CLI002" &&
      /--migration-id.*--output/u.test(error.message),
  );
  assert.throws(
    () => parseArgv([
      "setup",
      "--workspace",
      workspace,
      "--output",
      resolve("bundle.json"),
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI005",
  );
});

test("setup accepts reviewed predecessor confirmation while init remains a compatibility alias", () => {
  const workspace = resolve("workspace");
  const parsed = parseArgv([
    "setup",
    "--workspace",
    workspace,
    "--confirm-predecessor-reviewed",
  ]);
  assert.equal(parsed.options.confirmPredecessorReviewed, true);
  assert.throws(
    () => parseArgv([
      "init",
      "--workspace",
      workspace,
      "--confirm-predecessor-reviewed",
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI005",
  );
  assert.match(helpText(), /\n  init\s+Compatibility alias for setup/u);
  assert.match(helpText("setup"), /--confirm-predecessor-reviewed/u);
  const patch = parseArgv([
    "patch-agents",
    "--workspace",
    workspace,
    "--confirm-predecessor-reviewed",
  ]);
  assert.equal(patch.options.confirmPredecessorReviewed, true);
  assert.match(helpText("patch-agents"), /--confirm-predecessor-reviewed/u);
});

test("setup, bundle, and adopt are first-class help surfaces", () => {
  assert.match(helpText(), /\n  setup\s+Initialize a greenfield workspace/u);
  assert.match(helpText(), /\n  bundle\s+Build one reviewed legacy-adoption bundle/u);
  assert.match(helpText(), /\n  adopt\s+Apply one reviewed legacy-adoption bundle/u);
  assert.match(helpText("bundle"), /content-addressed descriptor consumed by syncora adopt/u);
  assert.match(helpText("adopt"), /stage, shadow, cutover, verify, and retire/u);
});
