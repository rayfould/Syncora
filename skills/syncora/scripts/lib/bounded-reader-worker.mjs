import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

import {
  boundedReadIdentityFromStat,
  encodeBoundedReadEnvelope,
} from "./bounded-reader-protocol.mjs";

const [path, maximumText] = process.argv.slice(2);
const maximumBytes = Number.parseInt(maximumText, 10);

function fail(reason, status) {
  process.stderr.write(`SYNCORA_SAFE_READ:${reason}`);
  process.exitCode = status;
}

async function readAtMost(handle, maximum) {
  const target = Buffer.alloc(maximum + 1);
  let offset = 0;
  while (offset < target.length) {
    const { bytesRead } = await handle.read(
      target,
      offset,
      target.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return target.subarray(0, offset);
}

async function main() {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 32_768 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    maximumBytes > 16_777_216
  ) {
    fail("PROTOCOL", 40);
    return;
  }

  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY);
    const beforeMetadata = await handle.stat({ bigint: true });
    if (!beforeMetadata.isFile()) {
      fail("NOT_REGULAR", 41);
      return;
    }
    if (beforeMetadata.size > BigInt(maximumBytes)) {
      fail("TOO_LARGE", 42);
      return;
    }

    const bytes = await readAtMost(handle, maximumBytes);
    const afterMetadata = await handle.stat({ bigint: true });
    if (!afterMetadata.isFile()) {
      fail("NOT_REGULAR", 41);
      return;
    }
    if (
      bytes.length > maximumBytes ||
      afterMetadata.size > BigInt(maximumBytes)
    ) {
      fail("TOO_LARGE", 42);
      return;
    }

    const envelope = encodeBoundedReadEnvelope({
      before: boundedReadIdentityFromStat(beforeMetadata),
      after: boundedReadIdentityFromStat(afterMetadata),
      bytes,
    });
    await new Promise((resolve, reject) => {
      process.stdout.write(envelope, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } catch (error) {
    const code = String(error?.code ?? "UNKNOWN");
    fail(`FS:${/^[A-Z0-9_]{1,48}$/.test(code) ? code : "UNKNOWN"}`, 43);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

await main();
