import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  decodeBoundedReadEnvelope,
  encodeBoundedReadEnvelope,
} from "../../skills/syncora/scripts/lib/bounded-reader-protocol.mjs";
import { readSyncoraLocalConfigIfPresent } from "../../skills/syncora/scripts/lib/workspace.mjs";

function identity(size, overrides = {}) {
  return {
    birthtimeNs: "100",
    ctimeNs: "101",
    dev: "1",
    ino: "2",
    kind: "file",
    mode: "33188",
    mtimeNs: "102",
    size: String(size),
    ...overrides,
  };
}

async function temporaryWorkspace() {
  const workspace = await mkdtemp(join(tmpdir(), "syncora-bounded-reader-"));
  await mkdir(join(workspace, ".syncora"));
  return workspace;
}

test("bounded-reader binary envelopes are exact, binary-safe, and versioned", () => {
  const bytes = Buffer.from([0x00, 0xff, 0x7f, 0x0a]);
  const envelope = encodeBoundedReadEnvelope({
    before: identity(bytes.length),
    after: identity(bytes.length),
    bytes,
  });
  const decoded = decodeBoundedReadEnvelope(envelope, bytes.length);

  assert.deepEqual(decoded.before, identity(bytes.length));
  assert.deepEqual(decoded.after, identity(bytes.length));
  assert.deepEqual(decoded.bytes, bytes);

  assert.throws(
    () => decodeBoundedReadEnvelope(Buffer.concat([envelope, Buffer.of(0)]), 4),
    /length does not match/,
  );
  const oversizedHeader = Buffer.from(envelope);
  oversizedHeader.writeUInt32BE(4_097, 8);
  assert.throws(
    () => decodeBoundedReadEnvelope(oversizedHeader, 4),
    /lengths are invalid/,
  );
  const unsupported = Buffer.from(envelope);
  unsupported[0] ^= 0xff;
  assert.throws(
    () => decodeBoundedReadEnvelope(unsupported, 4),
    /magic is invalid/,
  );
});

test(
  "the parent rejects a different file opened in the final race window",
  async (t) => {
    const workspace = await temporaryWorkspace();
    const replacementRoot = await mkdtemp(
      join(tmpdir(), "syncora-bounded-replacement-"),
    );
    const localConfigPath = join(workspace, ".syncora", "local.json");
    const replacementPath = join(replacementRoot, "replacement.json");
    const probePath = join(workspace, ".syncora", "hardlink-probe");
    const bytes = '{"schemaVersion":1,"externalGraphRoots":[]}\n';
    try {
      await writeFile(localConfigPath, bytes, "utf8");
      await writeFile(replacementPath, bytes, "utf8");
      try {
        await link(replacementPath, probePath);
        await rm(probePath);
      } catch (error) {
        t.skip(`Hard links unavailable: ${error.message}`);
        return;
      }

      await assert.rejects(
        readSyncoraLocalConfigIfPresent(workspace, {
          beforeHandleOpen: async () => {
            await rm(localConfigPath);
            await link(replacementPath, localConfigPath);
          },
        }),
        (error) =>
          error?.code === "CONFIG002" &&
          error?.details?.reason === "changed",
      );
      assert.equal(await readFile(replacementPath, "utf8"), bytes);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(replacementRoot, { recursive: true, force: true });
    }
  },
);

test(
  "the Windows isolated reader kills a child at its hard deadline",
  { skip: process.platform !== "win32" },
  async () => {
    const workspace = await temporaryWorkspace();
    const localConfigPath = join(workspace, ".syncora", "local.json");
    try {
      await writeFile(
        localConfigPath,
        '{"schemaVersion":1,"externalGraphRoots":[]}\n',
        "utf8",
      );
      const startedAt = Date.now();
      await assert.rejects(
        readSyncoraLocalConfigIfPresent(workspace, {
          isolatedReaderProgram: "setInterval(() => {}, 10_000);",
          readTimeoutMs: 200,
        }),
        (error) =>
          error?.code === "CONFIG002" &&
          error?.details?.reason === "timeout",
      );
      assert.ok(Date.now() - startedAt < 5_000);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
);

for (const [stream, program] of [
  ["stdout", "process.stdout.write(Buffer.alloc(100_000));"],
  ["stderr", "process.stderr.write(Buffer.alloc(2_000));"],
]) {
  test(
    `the Windows isolated reader caps ${stream}`,
    { skip: process.platform !== "win32" },
    async () => {
      const workspace = await temporaryWorkspace();
      const localConfigPath = join(workspace, ".syncora", "local.json");
      try {
        await writeFile(
          localConfigPath,
          '{"schemaVersion":1,"externalGraphRoots":[]}\n',
          "utf8",
        );
        await assert.rejects(
          readSyncoraLocalConfigIfPresent(workspace, {
            isolatedReaderProgram: program,
          }),
          (error) =>
            error?.code === "CONFIG002" &&
            error?.details?.reason === "protocol",
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
}
