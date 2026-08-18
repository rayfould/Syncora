import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";

import {
  boundedReadIdentityFromStat,
  encodeBoundedReadEnvelope,
} from "./bounded-reader-protocol.mjs";

const path = workerData?.path;
const maximumBytes = workerData?.maximumBytes;

function fail(reason, code = undefined) {
  return code === undefined
    ? { kind: "error", reason }
    : { code, kind: "error", reason };
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
    return fail("PROTOCOL");
  }

  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY);
    const beforeMetadata = await handle.stat({ bigint: true });
    if (!beforeMetadata.isFile()) return fail("NOT_REGULAR");
    if (beforeMetadata.size > BigInt(maximumBytes)) return fail("TOO_LARGE");

    const bytes = await readAtMost(handle, maximumBytes);
    const afterMetadata = await handle.stat({ bigint: true });
    if (!afterMetadata.isFile()) return fail("NOT_REGULAR");
    if (bytes.length > maximumBytes || afterMetadata.size > BigInt(maximumBytes)) {
      return fail("TOO_LARGE");
    }

    return {
      kind: "success",
      envelope: encodeBoundedReadEnvelope({
        before: boundedReadIdentityFromStat(beforeMetadata),
        after: boundedReadIdentityFromStat(afterMetadata),
        bytes,
      }),
    };
  } catch (error) {
    const code = String(error?.code ?? "UNKNOWN");
    return fail("FS", /^[A-Z0-9_]{1,48}$/.test(code) ? code : "UNKNOWN");
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

parentPort?.postMessage(await main());
