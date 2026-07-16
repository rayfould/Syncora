import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  ADOPTION_BUNDLE_POLICY,
  loadAndValidateAdoptionBundle,
} from "../../skills/syncora/scripts/lib/adoption-bundle.mjs";

function taggedHash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function write(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

async function bundleFixture() {
  const container = await mkdtemp(join(tmpdir(), "syncora-adoption-bundle-"));
  const root = join(container, "pack");
  const stagedRoot = join(root, "staged-content");
  const descriptorPath = join(root, "adoption-bundle-v1.json");
  const manifestPath = join(root, "reviewed", "manifest.json");
  const fixturesPath = join(root, "reviewed", "fixtures.json");
  const targetBytes = new Map([
    ["index.md", Buffer.from("# Atlas\n", "utf8")],
    ["knowledge/projects/workspace.md", Buffer.from("# Workspace\n", "utf8")],
  ]);
  const targets = [...targetBytes]
    .map(([path, bytes]) => ({
      path,
      sha256: taggedHash(bytes),
      byteLength: bytes.length,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const target of targets) {
    await write(
      join(stagedRoot, ...target.path.split("/")),
      targetBytes.get(target.path),
    );
  }
  const manifest = {
    manifestSchemaVersion: 2,
    kind: "syncora.authority-promotion",
    status: "reviewed",
    operations: targets.map((target, index) => ({
      operationId: `operation-${index + 1}`,
      target: {
        path: target.path,
        contentSha256: target.sha256,
      },
    })),
  };
  const fixtures = {
    schemaVersion: 1,
    kind: "syncora-shadow-fixtures-v1",
    cases: [{ caseId: "workspace", query: "workspace" }],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const fixtureBytes = Buffer.from(`${JSON.stringify(fixtures, null, 2)}\n`, "utf8");
  await write(manifestPath, manifestBytes);
  await write(fixturesPath, fixtureBytes);
  const descriptor = {
    schemaVersion: 1,
    kind: ADOPTION_BUNDLE_POLICY.kind,
    migrationId: "legacy-adoption",
    manifest: {
      path: "reviewed/manifest.json",
      sha256: taggedHash(manifestBytes),
    },
    stagedContent: {
      root: "staged-content",
      targetCount: targets.length,
      totalBytes: targets.reduce((sum, target) => sum + target.byteLength, 0),
      targets,
    },
    fixtures: {
      path: "reviewed/fixtures.json",
      sha256: taggedHash(fixtureBytes),
    },
  };
  await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  return {
    container,
    root,
    stagedRoot,
    descriptorPath,
    manifestPath,
    fixturesPath,
    descriptor,
    targets,
  };
}

test("one adoption descriptor binds the reviewed manifest, fixtures, and every staged target", async () => {
  const fixture = await bundleFixture();
  try {
    const loaded = await loadAndValidateAdoptionBundle(fixture.descriptorPath);
    assert.equal(loaded.migrationId, "legacy-adoption");
    assert.equal(loaded.bundleRoot, fixture.root);
    assert.equal(loaded.manifest.path, fixture.manifestPath);
    assert.equal(loaded.fixtures.path, fixture.fixturesPath);
    assert.equal(loaded.stagedContent.path, fixture.stagedRoot);
    assert.equal(loaded.stagedContent.targetCount, 2);
    assert.deepEqual(
      loaded.stagedContent.targets.map(({ path, sha256, byteLength }) => ({
        path,
        sha256,
        byteLength,
      })),
      fixture.targets,
    );
    assert.match(loaded.descriptor.sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(Object.isFrozen(loaded), true);
  } finally {
    await rm(fixture.container, { recursive: true, force: true });
  }
});

test("bundle validation fails closed on descriptor, manifest, fixture, and target hash divergence", async (t) => {
  await t.test("manifest hash", async () => {
    const fixture = await bundleFixture();
    try {
      await writeFile(fixture.manifestPath, "{}\n");
      await assert.rejects(
        loadAndValidateAdoptionBundle(fixture.descriptorPath),
        (error) => error?.code === "MIGRATE016" && /manifest hash/i.test(error.message),
      );
    } finally {
      await rm(fixture.container, { recursive: true, force: true });
    }
  });

  await t.test("fixture hash", async () => {
    const fixture = await bundleFixture();
    try {
      await writeFile(fixture.fixturesPath, "{}\n");
      await assert.rejects(
        loadAndValidateAdoptionBundle(fixture.descriptorPath),
        (error) => error?.code === "MIGRATE016" && /fixture hash/i.test(error.message),
      );
    } finally {
      await rm(fixture.container, { recursive: true, force: true });
    }
  });

  await t.test("target hash", async () => {
    const fixture = await bundleFixture();
    try {
      await writeFile(join(fixture.stagedRoot, "index.md"), "# Changed\n");
      await assert.rejects(
        loadAndValidateAdoptionBundle(fixture.descriptorPath),
        (error) => error?.code === "MIGRATE016" && /target bytes/i.test(error.message),
      );
    } finally {
      await rm(fixture.container, { recursive: true, force: true });
    }
  });

  await t.test("manifest target binding", async () => {
    const fixture = await bundleFixture();
    try {
      fixture.descriptor.stagedContent.targets[0].sha256 = `sha256:${"0".repeat(64)}`;
      await writeFile(
        fixture.descriptorPath,
        `${JSON.stringify(fixture.descriptor, null, 2)}\n`,
      );
      await assert.rejects(
        loadAndValidateAdoptionBundle(fixture.descriptorPath),
        (error) =>
          error?.code === "MIGRATE016" && /diverges from the manifest/i.test(error.message),
      );
    } finally {
      await rm(fixture.container, { recursive: true, force: true });
    }
  });
});

test("bundle paths are relative descendants with a single portable identity", async (t) => {
  const invalidPaths = [
    "../manifest.json",
    "/absolute/manifest.json",
    "reviewed\\manifest.json",
    "reviewed/../manifest.json",
    "reviewed/CON.json",
  ];
  for (const invalidPath of invalidPaths) {
    await t.test(invalidPath.replaceAll("\\", "-"), async () => {
      const fixture = await bundleFixture();
      try {
        fixture.descriptor.manifest.path = invalidPath;
        await writeFile(
          fixture.descriptorPath,
          `${JSON.stringify(fixture.descriptor, null, 2)}\n`,
        );
        await assert.rejects(
          loadAndValidateAdoptionBundle(fixture.descriptorPath),
          (error) => error?.code === "MIGRATE016" && /path/i.test(error.message),
        );
      } finally {
        await rm(fixture.container, { recursive: true, force: true });
      }
    });
  }
});

test("a staged-content symlink or junction cannot escape the bundle", async (t) => {
  const fixture = await bundleFixture();
  const outside = join(fixture.container, "outside");
  try {
    await mkdir(outside);
    for (const target of fixture.targets) {
      await write(join(outside, ...target.path.split("/")), Buffer.from(
        target.path === "index.md" ? "# Atlas\n" : "# Workspace\n",
        "utf8",
      ));
    }
    await rm(fixture.stagedRoot, { recursive: true, force: true });
    try {
      await symlink(
        outside,
        fixture.stagedRoot,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
        t.skip("Directory link creation is unavailable on this host.");
        return;
      }
      throw error;
    }
    await assert.rejects(
      loadAndValidateAdoptionBundle(fixture.descriptorPath),
      (error) =>
        error?.code === "MIGRATE016" && /symlink|junction|safe directory|alias/i.test(error.message),
    );
  } finally {
    await rm(fixture.container, { recursive: true, force: true });
  }
});

test("descriptor mutation during its bounded read is rejected", async () => {
  const fixture = await bundleFixture();
  let mutated = false;
  try {
    await assert.rejects(
      loadAndValidateAdoptionBundle(fixture.descriptorPath, {
        afterRead: async ({ kind, path }) => {
          if (kind !== "descriptor" || mutated) return;
          mutated = true;
          const current = await readFile(path, "utf8");
          await writeFile(path, `${current.trimEnd()}  \n`);
        },
      }),
      (error) =>
        error?.code === "MIGRATE016" && /changed while it was being read/i.test(error.message),
    );
  } finally {
    await rm(fixture.container, { recursive: true, force: true });
  }
});
