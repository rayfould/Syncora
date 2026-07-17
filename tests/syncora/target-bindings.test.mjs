import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  invalidNoteTargetBindings,
  normalizeTargetSpecifiers,
  parseTargetSpecifier,
  resolveNoteTargetBindings,
  TARGET_BINDING_POLICY,
  untypedNoteTargetBindings,
} from "../../skills/syncora/scripts/lib/target-bindings.mjs";

function note(appliesTo) {
  return { frontmatter: { applies_to: appliesTo } };
}

test("typed context targets normalize deterministically and deduplicate", () => {
  assert.deepEqual(parseTargetSpecifier("file:Src\\Auth\\Session.ts"), {
    kind: "file",
    ref: "Src/Auth/Session.ts",
    originalRef: "Src\\Auth\\Session.ts",
  });
  assert.deepEqual(
    normalizeTargetSpecifiers([
      "file:src/auth/session.ts",
      "file:SRC\\AUTH\\SESSION.TS",
      "module:src/auth",
      "component:Authentication",
      "symbol:typescript:src/auth/session.ts#verify",
      "path_glob:src/auth/**/*.ts",
    ]).map(({ kind, ref }) => ({ kind, ref })),
    [
      { kind: "file", ref: "src/auth/session.ts" },
      { kind: "file", ref: "SRC/AUTH/SESSION.TS" },
      { kind: "module", ref: "src/auth" },
      { kind: "component", ref: "Authentication" },
      { kind: "symbol", ref: "typescript:src/auth/session.ts#verify" },
      { kind: "path_glob", ref: "src/auth/**/*.ts" },
    ],
  );
});

test("target binding resolution is typed, bounded, and explicit", () => {
  const target = normalizeTargetSpecifiers(["file:src/auth/session.ts"]);
  const matches = resolveNoteTargetBindings(
    note([
      "file:src/auth/session.ts",
      "module:src/auth",
      "path_glob:src/**/*.ts",
      "symbol:src/auth/session.ts",
    ]),
    target,
  );
  assert.deepEqual(matches.map((item) => item.reason), ["exact_binding"]);
  assert.equal(matches.some((item) => item.bindingKind === "symbol"), false);
  assert.equal(
    resolveNoteTargetBindings(note(["module:src/auth"]), target)[0].reason,
    "module_parent",
  );
  assert.equal(
    resolveNoteTargetBindings(note(["path_glob:src/**/*.ts"]), target)[0].reason,
    "path_glob_match",
  );
  assert.deepEqual(
    resolveNoteTargetBindings(
      note(["file:src/Auth/session.ts"]),
      target,
    ),
    [],
  );
});

test("path globs use the bounded segment grammar and retain recursive matching", () => {
  const recursiveTargets = normalizeTargetSpecifiers([
    "file:src/index.ts",
    "file:src/auth/session.ts",
    "file:src/auth/session.js",
  ]);
  assert.deepEqual(
    resolveNoteTargetBindings(note(["path_glob:src/**/*.ts"]), recursiveTargets)
      .map((item) => item.targetRef),
    ["src/auth/session.ts", "src/index.ts"],
  );

  const segmentTargets = normalizeTargetSpecifiers([
    "file:src/Auth/session.ts",
    "file:src/auth/refresh.ts",
    "file:src/auth/deep/session.ts",
  ]);
  assert.deepEqual(
    resolveNoteTargetBindings(note(["path_glob:src/?uth/*.ts"]), segmentTargets)
      .map((item) => item.targetRef),
    ["src/Auth/session.ts", "src/auth/refresh.ts"],
  );
});

test("path glob grammar rejects repeated-star patterns in bounded time", () => {
  const invalidPatterns = [
    "path_glob:src/**/nested/**/file.ts",
    "path_glob:src/foo**/file.ts",
    "path_glob:src/**foo/file.ts",
    "path_glob:src/*foo*bar.ts",
    `path_glob:src/${"*a".repeat(100)}.ts`,
  ];
  const started = performance.now();
  for (let iteration = 0; iteration < 250; iteration += 1) {
    for (const value of invalidPatterns) {
      assert.throws(
        () => parseTargetSpecifier(value),
        (error) => error?.code === "CONTEXT_TARGET_INVALID",
      );
    }
  }
  assert.ok(
    performance.now() - started < 2_000,
    "strict glob rejection should not perform regex backtracking",
  );
});

test("each target materializes one best binding and preserves case-sensitive identities", () => {
  const targets = normalizeTargetSpecifiers([
    "file:Src/Auth/Session.ts",
    "file:Src/Auth/Refresh.ts",
    "component:AuthenticationCore",
    "symbol:typescript:Src/Auth/Session.ts#Rotate",
  ]);
  const matches = resolveNoteTargetBindings(
    note([
      "path_glob:Src/**/*.ts",
      "module:Src/Auth",
      "file:Src/Auth/Session.ts",
      "component:AuthenticationCore",
      "symbol:typescript:Src/Auth/Session.ts#Rotate",
    ]),
    targets,
  );

  assert.equal(matches.length, targets.length);
  assert.equal(new Set(matches.map((item) => item.target)).size, targets.length);
  assert.equal(
    matches.find((item) => item.targetRef === "Src/Auth/Session.ts").reason,
    "exact_binding",
  );
  assert.equal(
    matches.find((item) => item.targetRef === "Src/Auth/Refresh.ts").reason,
    "module_parent",
  );
  assert.ok(matches.some((item) => item.targetRef === "AuthenticationCore"));
  assert.ok(matches.some(
    (item) => item.targetRef === "typescript:Src/Auth/Session.ts#Rotate",
  ));
  assert.deepEqual(
    resolveNoteTargetBindings(
      note([
        "component:authenticationcore",
        "symbol:typescript:src/auth/session.ts#rotate",
      ]),
      targets,
    ),
    [],
  );
});

test("untyped legacy applies_to values never acquire selection authority", () => {
  const source = note(["src/auth/session.ts"]);
  assert.deepEqual(
    resolveNoteTargetBindings(
      source,
      normalizeTargetSpecifiers(["file:src/auth/session.ts"]),
    ),
    [],
  );
  assert.deepEqual(untypedNoteTargetBindings(source), ["src/auth/session.ts"]);
});

test("unsafe, unsupported, and excessive target selectors fail closed", () => {
  for (const value of [
    "file:../outside.ts",
    "file:C:/outside.ts",
    "file:/outside.ts",
    "file:src/**/file.ts",
    "path_glob:src/{auth,users}/*.ts",
    "unknown:src/auth.ts",
    "component:two words",
  ]) {
    assert.throws(
      () => parseTargetSpecifier(value),
      (error) => error?.code === "CONTEXT_TARGET_INVALID",
      value,
    );
  }
  assert.throws(
    () => normalizeTargetSpecifiers(
      Array.from(
        { length: TARGET_BINDING_POLICY.maximumTargets + 1 },
        (_, index) => `file:src/file-${index}.ts`,
      ),
    ),
    (error) => error?.code === "CONTEXT_TARGET_INVALID",
  );
});

test("file, module, and glob paths reject non-portable Windows names", () => {
  for (const value of [
    "file:src/a<b.ts",
    "file:src/a>b.ts",
    "file:src/a:b.ts",
    "file:src/a\"b.ts",
    "file:src/a|b.ts",
    "file:src/CON",
    "file:src/con.txt",
    "module:src/AUX.md",
    "module:src/NUL",
    "file:src/CONIN$",
    "file:src/CONOUT$.txt",
    "file:src/COM1.js",
    "file:src/COM\u00b9.js",
    "file:src/LPT9.ts",
    "file:src/LPT\u00b3.ts",
    "file:src/name.",
    "path_glob:src/PRN/*.ts",
    "path_glob:src/name./*.ts",
  ]) {
    assert.throws(
      () => parseTargetSpecifier(value),
      (error) => error?.code === "CONTEXT_TARGET_INVALID",
      value,
    );
  }

  assert.equal(
    parseTargetSpecifier("path_glob:src/CO?/*.ts").ref,
    "src/CO?/*.ts",
  );
  assert.equal(parseTargetSpecifier("file: src/name ").ref, "src/name");
});

test("target validation errors bound hostile kinds and references", () => {
  const hostileKind = "k".repeat(20_000);
  const hostileReference = "r".repeat(20_000);
  let kindError;
  let referenceError;
  try {
    parseTargetSpecifier(`${hostileKind}:ref`);
  } catch (error) {
    kindError = error;
  }
  try {
    parseTargetSpecifier(`file:${hostileReference}`);
  } catch (error) {
    referenceError = error;
  }

  assert.equal(kindError?.code, "CONTEXT_TARGET_INVALID");
  assert.equal(kindError?.message, "Unsupported target kind.");
  assert.equal(kindError?.details?.kind?.truncated, true);
  assert.ok(kindError.details.kind.value.length <= TARGET_BINDING_POLICY.maximumErrorReferenceCharacters);
  assert.ok(JSON.stringify(kindError.details).length < 1_000);

  assert.equal(referenceError?.code, "CONTEXT_TARGET_INVALID");
  assert.equal(referenceError?.details?.targetRefTruncated, true);
  assert.ok(referenceError.details.targetRef.length <= TARGET_BINDING_POLICY.maximumErrorReferenceCharacters);
  assert.ok(JSON.stringify(referenceError.details).length < 1_000);
});

test("malformed typed bindings remain visible but non-selecting", () => {
  const note = {
    frontmatter: {
      applies_to: ["file:../secrets.txt", "path_glob:src/[abc].ts", "file:src/safe.ts"],
    },
  };
  assert.deepEqual(invalidNoteTargetBindings(note), [
    "file:../secrets.txt",
    "path_glob:src/[abc].ts",
  ]);
  const targets = normalizeTargetSpecifiers(["file:src/safe.ts"]);
  assert.equal(resolveNoteTargetBindings(note, targets).length, 1);
});
