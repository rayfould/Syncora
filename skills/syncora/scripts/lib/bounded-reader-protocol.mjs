const MAGIC = Buffer.from("SYNRD001", "ascii");

export const BOUNDED_READ_PROTOCOL_VERSION = 1;
export const BOUNDED_READ_PREFIX_BYTES = 16;
export const BOUNDED_READ_MAX_HEADER_BYTES = 4_096;
export const BOUNDED_READ_MAX_STDERR_BYTES = 1_024;

const IDENTITY_KEYS = [
  "birthtimeNs",
  "ctimeNs",
  "dev",
  "ino",
  "kind",
  "mode",
  "mtimeNs",
  "size",
];
const UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]{0,39})$/;
const SIGNED_DECIMAL = /^-?(?:0|[1-9][0-9]{0,39})$/;

function assertMaximumBytes(maximumBytes) {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    maximumBytes > 16_777_216
  ) {
    throw new TypeError("Bounded-reader maximumBytes is invalid.");
  }
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])
  ) {
    throw new TypeError(`${label} has an invalid schema.`);
  }
}

export function validateBoundedReadIdentity(identity) {
  assertExactKeys(identity, IDENTITY_KEYS, "Bounded-reader identity");
  if (identity.kind !== "file") {
    throw new TypeError("Bounded-reader identity is not a regular file.");
  }
  for (const key of ["dev", "ino", "mode", "size"]) {
    if (typeof identity[key] !== "string" || !UNSIGNED_DECIMAL.test(identity[key])) {
      throw new TypeError(`Bounded-reader identity ${key} is invalid.`);
    }
  }
  for (const key of ["mtimeNs", "ctimeNs", "birthtimeNs"]) {
    if (typeof identity[key] !== "string" || !SIGNED_DECIMAL.test(identity[key])) {
      throw new TypeError(`Bounded-reader identity ${key} is invalid.`);
    }
  }
  return identity;
}

export function boundedReadIdentityFromStat(metadata) {
  if (!metadata?.isFile?.()) {
    throw new TypeError("Bounded-reader metadata is not a regular file.");
  }
  return validateBoundedReadIdentity({
    kind: "file",
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    mode: String(metadata.mode),
    size: String(metadata.size),
    mtimeNs: String(metadata.mtimeNs),
    ctimeNs: String(metadata.ctimeNs),
    birthtimeNs: String(metadata.birthtimeNs),
  });
}

export function sameBoundedReadIdentity(left, right) {
  try {
    validateBoundedReadIdentity(left);
    validateBoundedReadIdentity(right);
  } catch {
    return false;
  }
  return IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

export function boundedReadStdoutLimit(maximumBytes) {
  assertMaximumBytes(maximumBytes);
  return (
    BOUNDED_READ_PREFIX_BYTES +
    BOUNDED_READ_MAX_HEADER_BYTES +
    maximumBytes
  );
}

export function encodeBoundedReadEnvelope({ before, after, bytes }) {
  validateBoundedReadIdentity(before);
  validateBoundedReadIdentity(after);
  if (!Buffer.isBuffer(bytes)) {
    throw new TypeError("Bounded-reader bytes must be a Buffer.");
  }
  if (bytes.length > 16_777_216) {
    throw new TypeError("Bounded-reader bytes are too large.");
  }

  const header = Buffer.from(
    JSON.stringify({
      schemaVersion: BOUNDED_READ_PROTOCOL_VERSION,
      before,
      after,
    }),
    "utf8",
  );
  if (header.length === 0 || header.length > BOUNDED_READ_MAX_HEADER_BYTES) {
    throw new TypeError("Bounded-reader envelope header is too large.");
  }

  const envelope = Buffer.allocUnsafe(
    BOUNDED_READ_PREFIX_BYTES + header.length + bytes.length,
  );
  MAGIC.copy(envelope, 0);
  envelope.writeUInt32BE(header.length, 8);
  envelope.writeUInt32BE(bytes.length, 12);
  header.copy(envelope, BOUNDED_READ_PREFIX_BYTES);
  bytes.copy(envelope, BOUNDED_READ_PREFIX_BYTES + header.length);
  return envelope;
}

export function decodeBoundedReadEnvelope(envelope, maximumBytes) {
  assertMaximumBytes(maximumBytes);
  if (!Buffer.isBuffer(envelope)) {
    throw new TypeError("Bounded-reader envelope must be a Buffer.");
  }
  if (envelope.length < BOUNDED_READ_PREFIX_BYTES) {
    throw new TypeError("Bounded-reader envelope is truncated.");
  }
  if (!envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new TypeError("Bounded-reader envelope magic is invalid.");
  }

  const headerLength = envelope.readUInt32BE(8);
  const payloadLength = envelope.readUInt32BE(12);
  if (
    headerLength === 0 ||
    headerLength > BOUNDED_READ_MAX_HEADER_BYTES ||
    payloadLength > maximumBytes
  ) {
    throw new TypeError("Bounded-reader envelope lengths are invalid.");
  }
  const expectedLength =
    BOUNDED_READ_PREFIX_BYTES + headerLength + payloadLength;
  if (envelope.length !== expectedLength) {
    throw new TypeError("Bounded-reader envelope length does not match its prefix.");
  }

  let header;
  try {
    const headerBytes = envelope.subarray(
      BOUNDED_READ_PREFIX_BYTES,
      BOUNDED_READ_PREFIX_BYTES + headerLength,
    );
    const headerText = new TextDecoder("utf-8", { fatal: true }).decode(
      headerBytes,
    );
    header = JSON.parse(headerText);
  } catch {
    throw new TypeError("Bounded-reader envelope header is invalid.");
  }
  assertExactKeys(
    header,
    ["after", "before", "schemaVersion"],
    "Bounded-reader envelope header",
  );
  if (header.schemaVersion !== BOUNDED_READ_PROTOCOL_VERSION) {
    throw new TypeError("Bounded-reader envelope version is unsupported.");
  }
  validateBoundedReadIdentity(header.before);
  validateBoundedReadIdentity(header.after);

  return {
    before: header.before,
    after: header.after,
    bytes: Buffer.from(
      envelope.subarray(BOUNDED_READ_PREFIX_BYTES + headerLength),
    ),
  };
}
