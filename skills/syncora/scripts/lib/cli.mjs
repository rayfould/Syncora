export const VERSION = "0.1.0-preview.1";

export class SyncoraError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "SyncoraError";
    this.code = code;
    this.details = details;
  }
}

const COMMANDS = new Set([
  "backlinks",
  "checkpoint",
  "doctor",
  "init",
  "migrate",
  "patch-agents",
  "search",
  "unpatch-agents",
  "validate",
]);

const VALUE_OPTIONS = new Set([
  "--workspace",
  "--format",
  "--allow-external-graph-root",
  "--note",
  "--limit",
  "--query",
  "--phase",
  "--cursor",
  "--profile",
  "--checkpoint-id",
]);

export function parseArgv(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { command: "help", options: {} };
  }

  if (argv[0] === "--version" || argv[0] === "-v") {
    return { command: "version", options: {} };
  }

  const command = argv[0];
  if (!COMMANDS.has(command)) {
    throw new SyncoraError("CLI001", `Unknown command: ${command}`);
  }

  const options = {
    workspace: undefined,
    format: "text",
    dryRun: false,
    patchAgents: true,
    allowExternalGraphRoot: undefined,
    note: undefined,
    query: undefined,
    limit: undefined,
    phase: undefined,
    cursor: undefined,
    profile: undefined,
    checkpointId: undefined,
    force: false,
    noCache: false,
    includeHistory: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--help" || token === "-h") {
      return { command: "help", options: { topic: command } };
    }

    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (token === "--no-patch-agents") {
      options.patchAgents = false;
      continue;
    }

    if (token === "--no-cache") {
      options.noCache = true;
      continue;
    }

    if (token === "--include-history") {
      options.includeHistory = true;
      continue;
    }

    if (token === "--force") {
      options.force = true;
      continue;
    }

    if (VALUE_OPTIONS.has(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new SyncoraError("CLI002", `Missing value for ${token}`);
      }
      index += 1;

      if (token === "--workspace") options.workspace = value;
      if (token === "--format") options.format = value;
      if (token === "--allow-external-graph-root") {
        options.allowExternalGraphRoot = value;
      }
      if (token === "--note") options.note = value;
      if (token === "--query") options.query = value;
      if (token === "--phase") options.phase = value;
      if (token === "--cursor") options.cursor = value;
      if (token === "--profile") options.profile = value;
      if (token === "--checkpoint-id") options.checkpointId = value;
      if (token === "--limit") {
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new SyncoraError("CLI004", "--limit must be an integer from 1 through 100.");
        }
        options.limit = limit;
      }
      continue;
    }

    throw new SyncoraError("CLI003", `Unknown option: ${token}`);
  }

  if (!options.workspace) {
    throw new SyncoraError(
      "WORKSPACE001",
      `${command} requires --workspace with an absolute path.`,
    );
  }

  if (!new Set(["text", "json"]).has(options.format)) {
    throw new SyncoraError(
      "CLI004",
      `Unsupported output format: ${options.format}`,
    );
  }

  if (command !== "init" && options.patchAgents === false) {
    throw new SyncoraError(
      "CLI005",
      "--no-patch-agents is only valid with init.",
    );
  }

  if (command === "backlinks" && !options.note) {
    throw new SyncoraError("CLI002", "backlinks requires --note <path-or-alias>.");
  }
  if (command !== "backlinks" && options.note !== undefined) {
    throw new SyncoraError("CLI005", "--note is only valid with backlinks.");
  }
  if (command === "search" && !options.query) {
    throw new SyncoraError("CLI002", "search requires --query <text>.");
  }
  if (command !== "search" && options.query !== undefined) {
    throw new SyncoraError("CLI005", "--query is only valid with search.");
  }
  if (command !== "search" && (options.noCache || options.includeHistory)) {
    throw new SyncoraError(
      "CLI005",
      "--no-cache and --include-history are only valid with search.",
    );
  }
  if (command === "search" && options.dryRun) {
    throw new SyncoraError("CLI005", "Use search --no-cache instead of --dry-run.");
  }
  if (!new Set(["migrate", "checkpoint"]).has(command) && options.phase !== undefined) {
    throw new SyncoraError(
      "CLI005",
      "--phase is only valid with migrate or checkpoint.",
    );
  }
  if (command !== "migrate" && options.cursor !== undefined) {
    throw new SyncoraError("CLI005", "--cursor is only valid with migrate.");
  }
  if (command === "migrate") {
    if (options.phase !== "authority" || !options.dryRun) {
      throw new SyncoraError(
        "MIGRATE001",
        "The current migrate surface requires --phase authority --dry-run.",
      );
    }
  }
  if (command === "checkpoint") {
    if (options.dryRun) {
      throw new SyncoraError("CLI005", "checkpoint does not support --dry-run.");
    }
    if (!new Set(["pre", "post"]).has(options.phase)) {
      throw new SyncoraError(
        "CLI004",
        "checkpoint requires --phase pre or --phase post.",
      );
    }
    if (options.phase === "pre") {
      if (!new Set(["checkpoint", "context", "capture", "maintenance"]).has(options.profile)) {
        throw new SyncoraError(
          "CLI004",
          "checkpoint pre requires --profile checkpoint, context, capture, or maintenance.",
        );
      }
      if (options.checkpointId !== undefined) {
        throw new SyncoraError(
          "CLI005",
          "--checkpoint-id is only valid with checkpoint --phase post.",
        );
      }
    } else {
      if (options.profile !== undefined) {
        throw new SyncoraError(
          "CLI005",
          "--profile is only valid with checkpoint --phase pre.",
        );
      }
      if (!options.checkpointId) {
        throw new SyncoraError(
          "CLI002",
          "checkpoint post requires --checkpoint-id <id>.",
        );
      }
    }
  } else if (options.profile !== undefined || options.checkpointId !== undefined) {
    throw new SyncoraError(
      "CLI005",
      "--profile and --checkpoint-id are only valid with checkpoint.",
    );
  }
  if (options.force && !(command === "checkpoint" && options.phase === "pre")) {
    throw new SyncoraError(
      "CLI005",
      "--force is only valid with checkpoint --phase pre.",
    );
  }
  if (command === "search") {
    options.limit ??= 10;
    if (options.limit > 50) {
      throw new SyncoraError("CLI004", "search --limit cannot exceed 50.");
    }
  } else if (command === "backlinks") {
    options.limit ??= 20;
  } else if (command === "migrate") {
    options.limit ??= 20;
  } else if (options.limit !== undefined) {
    throw new SyncoraError(
      "CLI005",
      "--limit is only valid with search, backlinks, or migrate.",
    );
  }

  return { command, options };
}

export function helpText(topic = undefined) {
  const common = [
    "--workspace <absolute-path>",
    "--dry-run",
    "--format <text|json>",
  ];

  if (topic === "init") {
    return [
      "Usage: syncora init --workspace <absolute-path> [options]",
      "",
      ...common,
      "--no-patch-agents",
      "--allow-external-graph-root <absolute-path>",
    ].join("\n");
  }

  if (topic === "doctor") {
    return [
      "Usage: syncora doctor --workspace <absolute-path> [options]",
      "",
      ...common,
      "--allow-external-graph-root <absolute-path>",
    ].join("\n");
  }

  if (topic === "validate") {
    return [
      "Usage: syncora validate --workspace <absolute-path> [options]",
      "",
      "--workspace <absolute-path>",
      "--format <text|json>",
      "--allow-external-graph-root <absolute-path>",
      "",
      "Validation is inherently read-only and works before initialization.",
    ].join("\n");
  }

  if (topic === "checkpoint") {
    return [
      "Usage:",
      "  syncora checkpoint --phase pre --profile <checkpoint|context|capture|maintenance> --workspace <absolute-path> [options]",
      "  syncora checkpoint --phase post --checkpoint-id <id> --workspace <absolute-path> [options]",
      "",
      "--workspace <absolute-path>",
      "--phase <pre|post>",
      "--profile <checkpoint|context|capture|maintenance>  (pre only)",
      "--checkpoint-id <id>  (post only)",
      "--force  (pre only)",
      "--format <text|json>",
      "--allow-external-graph-root <absolute-path>",
      "",
      "Preflight returns a bounded checkpoint ID. Postflight is an idempotent, fail-closed change disposition.",
    ].join("\n");
  }

  if (topic === "backlinks") {
    return [
      "Usage: syncora backlinks --workspace <absolute-path> --note <path-or-alias> [options]",
      "",
      "--workspace <absolute-path>",
      "--note <path-or-alias>",
      "--limit <1-100>",
      "--format <text|json>",
      "--allow-external-graph-root <absolute-path>",
      "",
      "Backlinks are derived in memory and never confer authority.",
    ].join("\n");
  }

  if (topic === "search") {
    return [
      "Usage: syncora search --workspace <absolute-path> --query <text> [options]",
      "",
      "--workspace <absolute-path>",
      "--query <text>",
      "--limit <1-50>",
      "--include-history",
      "--no-cache",
      "--format <text|json>",
      "--allow-external-graph-root <absolute-path>",
      "",
      "Search requires initialization. Its disposable cache has no authority.",
    ].join("\n");
  }

  if (topic === "migrate") {
    return [
      "Usage: syncora migrate --phase authority --dry-run --workspace <absolute-path> [options]",
      "",
      "--workspace <absolute-path>",
      "--phase authority",
      "--dry-run",
      "--limit <1-100>",
      "--cursor <opaque-token>",
      "--format <text|json>",
      "--allow-external-graph-root <absolute-path>",
      "",
      "This phase emits a bounded zero-authority inventory. It does not approve or apply promotion.",
    ].join("\n");
  }

  if (topic === "patch-agents" || topic === "unpatch-agents") {
    return [
      `Usage: syncora ${topic} --workspace <absolute-path> [options]`,
      "",
      ...common,
    ].join("\n");
  }

  return [
    "Syncora portable skill runtime",
    "",
    "Usage: syncora <command> [options]",
    "",
    "Commands:",
    "  backlinks       Resolve one note and list bounded reverse links",
    "  checkpoint      Run a foreground preflight or paired postflight",
    "  doctor          Inspect workspace readiness and safety",
    "  init            Create the bootstrap graph and patch agents",
    "  migrate         Preview a bounded migration phase without applying it",
    "  search          Rank bounded authority-aware lexical matches",
    "  validate        Inspect graph safety and authority read-only",
    "  patch-agents    Add or refresh project-local agent hooks",
    "  unpatch-agents  Restore or remove Syncora-owned hooks",
    "",
    "Run syncora <command> --help for command options.",
  ].join("\n");
}

function terminalSafe(value) {
  return String(value).replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    (character) =>
      `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function stringifyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    (character) =>
      `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function renderResult(result, format = "text") {
  if (format === "json") {
    return `${stringifyJson(result)}\n`;
  }

  const lines = [
    `Syncora ${result.command}: ${result.ok ? "ok" : "failed"}`,
  ];

  if (result.command === "checkpoint") {
    const prefix = result.validation.status === "degraded"
      ? "SYNCORA_DEGRADED"
      : "SYNCORA_OK";
    return `${prefix} phase=${result.checkpoint.phase} profile=${result.checkpoint.profile} sequence=${result.checkpoint.sequence} validation=${result.validation.mode} revision=${result.graph.revision} checkpoint=${terminalSafe(result.checkpoint.id)}${result.checkpoint.disposition ? ` disposition=${result.checkpoint.disposition}` : ""}${result.checkpoint.idempotent ? " idempotent=true" : ""}\n`;
  }

  if (result.command === "validate") {
    lines.push(`Workspace: ${terminalSafe(result.workspace)}`);
    lines.push(`Graph: ${terminalSafe(result.graph.root)}`);
    lines.push(`Revision: ${result.graph.revision}`);
    lines.push("Mode: read-only");
    lines.push(
      `Notes: ${result.summary.files.discovered} discovered, ${result.summary.files.quarantined} quarantined, ${result.summary.schema.legacy} legacy-schema, ${result.summary.authority.unpromoted} usable unpromoted`,
    );
    lines.push(
      `Links: ${result.summary.links.resolvedReferences}/${result.summary.links.uniqueReferences} resolved, ${result.summary.links.resolvedEdges} backlink edge(s), ${result.summary.links.unresolvedReferences} unresolved, ${result.summary.links.ambiguousReferences} ambiguous`,
    );
    lines.push(
      `Diagnostics: ${result.summary.diagnostics.error} error, ${result.summary.diagnostics.warning} warning`,
    );
    for (const diagnostic of result.diagnostics) {
      lines.push(
        `${diagnostic.severity.padEnd(7)} ${diagnostic.code}: ${diagnostic.message} (${diagnostic.occurrences})`,
      );
      for (const example of diagnostic.examples.slice(0, 3)) {
        if (example.path) lines.push(`          - ${terminalSafe(example.path)}`);
      }
      if (diagnostic.occurrences > 3) {
        lines.push(`          - ${diagnostic.occurrences - 3} more occurrence(s)`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  if (result.command === "backlinks") {
    lines.push(`Workspace: ${terminalSafe(result.workspace)}`);
    lines.push(`Graph: ${terminalSafe(result.graph.root)}`);
    lines.push(`Target: ${terminalSafe(result.target.path)} (${result.target.resolution})`);
    lines.push(
      `Backlinks: ${result.summary.returned} returned, ${result.summary.omitted} omitted`,
    );
    if (!result.summary.graphValid) {
      lines.push(
        `warning graph validation has ${result.summary.validationErrors} error(s); backlink authority remains informational`,
      );
    }
    for (const backlink of result.backlinks) {
      lines.push(`${backlink.authorityClass.padEnd(11)} ${terminalSafe(backlink.path)}`);
    }
    return `${lines.join("\n")}\n`;
  }

  if (result.command === "search") {
    lines.push(`Workspace: ${terminalSafe(result.workspace)}`);
    lines.push(`Graph: ${terminalSafe(result.graph.root)}`);
    lines.push(`Index: ${result.index.revision} (authority: none)`);
    lines.push(
      `Cache: ${result.cache.state}; ${result.cache.reused} reused, ${result.cache.rebuilt} rebuilt, ${result.cache.removed} removed`,
    );
    lines.push(
      `Matches: ${result.summary.returned} returned, ${result.summary.omitted} omitted from ${result.summary.eligible} eligible note(s)`,
    );
    if (!result.summary.graphValid) {
      lines.push(
        `warning graph validation has ${result.summary.validationErrors} error(s); quarantined sources remain excluded`,
      );
    }
    for (const item of result.results) {
      lines.push(
        `${item.score.toFixed(3).padStart(10)} ${item.authorityClass.padEnd(11)} ${terminalSafe(item.path)}`,
      );
    }
    for (const item of result.warnings) {
      lines.push(`warning ${item.code}: ${terminalSafe(item.message)}`);
    }
    return `${lines.join("\n")}\n`;
  }

  if (result.command === "migrate" && result.phase === "authority") {
    lines.push(`Workspace: ${terminalSafe(result.workspace)}`);
    lines.push(`Graph: ${terminalSafe(result.graph.root)}`);
    lines.push(`Revision: ${result.graph.revision}`);
    lines.push("Mode: read-only authority inventory");
    lines.push(
      `Inventory: ${result.summary.discovered} discovered, ${result.summary.currentSchema} current-schema, ${result.summary.reviewRequired} review-required, ${result.summary.blocked} blocked`,
    );
    lines.push(
      `Page: ${result.page.returned} returned, ${result.page.omittedBefore} before, ${result.page.omittedAfter} after`,
    );
    lines.push("Promotion ready: false (manifest acceptance is not implemented)");
    if (!result.summary.graphValid) {
      lines.push(
        `warning graph validation has ${result.summary.validationErrors} error(s)`,
      );
    }
    for (const entry of result.queue) {
      const digest = entry.source.sha256.slice(0, "sha256:".length + 12);
      lines.push(
        `${entry.classification.padEnd(15)} ${terminalSafe(entry.source.path)} (${digest}…)`,
      );
      if (entry.reasonCodes.length > 0) {
        lines.push(`                reasons: ${entry.reasonCodes.join(", ")}`);
      }
    }
    if (result.page.nextCursor) {
      lines.push(`Next cursor: ${terminalSafe(result.page.nextCursor)}`);
    }
    return `${lines.join("\n")}\n`;
  }

  if (result.workspace) lines.push(`Workspace: ${terminalSafe(result.workspace)}`);
  if (result.dryRun) lines.push("Mode: dry-run");

  for (const change of result.changes ?? []) {
    lines.push(`${change.action.padEnd(9)} ${terminalSafe(change.path)}`);
  }

  for (const check of result.checks ?? []) {
    lines.push(`${check.status.padEnd(7)} ${check.code}: ${terminalSafe(check.message)}`);
  }

  for (const warning of result.warnings ?? []) {
    lines.push(`warning ${warning.code}: ${terminalSafe(warning.message)}`);
  }

  return `${lines.join("\n")}\n`;
}

export function renderError(error, format = "text") {
  const normalized = {
    ok: false,
    error: {
      code: error instanceof SyncoraError ? error.code : "INTERNAL001",
      message: error instanceof Error ? error.message : String(error),
      ...(error?.details === undefined ? {} : { details: error.details }),
    },
  };

  if (format === "json") {
    return `${stringifyJson(normalized)}\n`;
  }

  return `Syncora failed [${normalized.error.code}]: ${terminalSafe(normalized.error.message)}\n`;
}
