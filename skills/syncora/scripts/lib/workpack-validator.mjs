import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TASKS = 256;
const VALID_STATUSES = new Set([
  "Pending",
  "Ready",
  "In Progress",
  "Blocked",
  "Complete",
  "Reopened",
]);
const TASK_ID = /^[A-Z][A-Z0-9]{1,7}-\d{3}$/u;
const TASK_FILE = /^([A-Z][A-Z0-9]{1,7}-\d{3})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u;
const PLACEHOLDER = /<[a-z][a-z0-9 _-]{1,80}>|\b(?:TODO|TBD|FIXME)\b|\?\?\?/iu;

const README_HEADINGS = [
  "Goal",
  "Required Reading",
  "Scope Boundary",
  "Task Graph",
  "Concurrency Rules",
  "Dirty Work Baseline",
  "Completion Gate",
];
const DESIGN_HEADINGS = [
  "Desired Outcome",
  "Current Reality and Evidence",
  "Scope and Non-Goals",
  "Design Contracts",
  "Responsibility and Data Ownership",
  "Required Behavior",
  "Forbidden Behavior",
  "Failure and Security Invariants",
  "Compatibility and Migration",
  "Rollout and Rollback",
  "Definition of Complete",
];
const TASK_HEADINGS = [
  "Outcome",
  "Design Contracts",
  "Preconditions",
  "File Ownership",
  "Shared Files",
  "Contract",
  "Proof-First Checklist",
  "Acceptance Criteria",
  "Evidence Destination",
  "Handoff",
];

export async function validateWorkpack(options) {
  const workspace = await resolveDirectory(options.workspace, "workspace");
  const workpackReference = normalizeWorkpackReference(options.workpack);
  const workpackRoot = await resolveDirectory(
    path.join(workspace, ...workpackReference.split("/")),
    "WorkPack",
  );
  assertContained(workspace, workpackRoot);

  const errors = [];
  const warnings = [];
  const readmePath = path.join(workpackRoot, "README.md");
  const designPath = path.join(workpackRoot, "design.md");
  const taskRoot = path.join(workpackRoot, "tasks");
  const [readme, design, taskFiles] = await Promise.all([
    readBoundedMarkdown(readmePath, "README.md"),
    readBoundedMarkdown(designPath, "design.md"),
    listTaskFiles(taskRoot),
  ]);

  checkHeadings(readme, README_HEADINGS, "README.md", errors);
  checkHeadings(design, DESIGN_HEADINGS, "design.md", errors);
  checkPlaceholders(readme, "README.md", errors);
  checkPlaceholders(design, "design.md", errors);

  const taskTable = parseTaskTable(readme, errors);
  const taskRecords = [];
  for (const filename of taskFiles) {
    const match = filename.match(TASK_FILE);
    if (!match) {
      errors.push(issue("TASK_PATH_INVALID", `tasks/${filename}`, "Task filenames must use PREFIX-001-stable-slug.md."));
      continue;
    }
    const source = await readBoundedMarkdown(path.join(taskRoot, filename), `tasks/${filename}`);
    const task = parseTaskFile(filename, match[1], source, errors);
    taskRecords.push(task);
  }

  validateTaskIndex(taskTable, taskRecords, errors);
  validateDependencies(taskTable, errors);
  validateDesignCoverage(design, taskRecords, errors);
  validateOwnership(taskRecords, errors);
  validateFinalVerification(taskTable, taskRecords, errors);

  const ok = errors.length === 0;
  return {
    reportSchemaVersion: 1,
    ok,
    command: "validate-workpack",
    kind: "syncora.workpack-validation",
    status: ok ? "ready" : "invalid",
    workspace,
    workpack: workpackReference,
    workpackRoot,
    summary: {
      tasks: taskRecords.length,
      indexedTasks: taskTable.size,
      designContracts: extractIds(design, /\bD-\d{3}\b/gu).size,
      errors: errors.length,
      warnings: warnings.length,
    },
    errors,
    warnings,
  };
}

async function resolveDirectory(value, label) {
  if (!value || typeof value !== "string") {
    throw inputError(`${label} path is required.`);
  }
  const resolved = await realpath(path.resolve(value));
  const stat = await lstat(resolved);
  if (!stat.isDirectory()) throw inputError(`${label} path must be a directory.`);
  return resolved;
}

function normalizeWorkpackReference(value) {
  const normalized = String(value ?? "").normalize("NFC").trim().replace(/\\/gu, "/");
  if (!normalized) throw inputError("--workpack is required.");
  if (path.isAbsolute(normalized) || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw inputError("--workpack must be a portable workspace-relative path.");
  }
  const parts = normalized.split("/");
  if (parts[0] !== "workpacks" || parts.length !== 2) {
    throw inputError("WorkPacks must use the fixed workpacks/<workpack-id> root.");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(parts[1])) {
    throw inputError("WorkPack IDs must use lowercase kebab-case.");
  }
  return normalized;
}

function assertContained(parent, child) {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (!relative) return;
    throw inputError("WorkPack resolves outside the workspace.");
  }
}

async function readBoundedMarkdown(filename, label) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw inputError(`${label} must be a regular file.`);
  if (stat.size > MAX_FILE_BYTES) throw inputError(`${label} exceeds ${MAX_FILE_BYTES} bytes.`);
  return readFile(filename, "utf8");
}

async function listTaskFiles(taskRoot) {
  const resolved = await realpath(taskRoot);
  const entries = await readdir(resolved, { withFileTypes: true });
  if (entries.length > MAX_TASKS) throw inputError(`WorkPack exceeds ${MAX_TASKS} task entries.`);
  const invalid = entries.find((entry) => !entry.isFile() || entry.isSymbolicLink());
  if (invalid) throw inputError(`tasks/${invalid.name} must be a regular file.`);
  return entries.map((entry) => entry.name).sort();
}

function checkHeadings(source, headings, label, errors) {
  for (const heading of headings) {
    if (!new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "mu").test(source)) {
      errors.push(issue("SECTION_MISSING", label, `Missing required section: ## ${heading}`));
    }
  }
}

function checkPlaceholders(source, label, errors) {
  if (PLACEHOLDER.test(source)) {
    errors.push(issue("PLACEHOLDER_UNRESOLVED", label, "Replace every placeholder, TODO, TBD, FIXME, or ??? before readiness."));
  }
}

function parseTaskTable(readme, errors) {
  const section = extractSection(readme, "Task Graph");
  const tasks = new Map();
  for (const line of section.split(/\r?\n/gu)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim().replace(/^`|`$/gu, ""));
    if (cells.length < 5 || cells[0] === "ID" || /^-+$/u.test(cells[0])) continue;
    const [id, title, status, dependencyText, owner] = cells;
    if (!TASK_ID.test(id)) {
      errors.push(issue("TASK_ID_INVALID", "README.md", `Invalid task ID in task table: ${id}`));
      continue;
    }
    if (tasks.has(id)) errors.push(issue("TASK_ID_DUPLICATE", "README.md", `Duplicate task ID: ${id}`));
    if (!VALID_STATUSES.has(status)) errors.push(issue("TASK_STATUS_INVALID", "README.md", `${id} has invalid status: ${status}`));
    const dependencies = /^none$/iu.test(dependencyText)
      ? []
      : dependencyText.split(",").map((item) => item.trim().replace(/`/gu, "")).filter(Boolean);
    tasks.set(id, { id, title, status, dependencies, owner });
  }
  if (tasks.size === 0) errors.push(issue("TASK_GRAPH_EMPTY", "README.md", "Task Graph must contain at least one task row."));
  return tasks;
}

function parseTaskFile(filename, filenameId, source, errors) {
  const label = `tasks/${filename}`;
  checkHeadings(source, TASK_HEADINGS, label, errors);
  checkPlaceholders(source, label, errors);
  const headingId = source.match(/^#\s+([A-Z][A-Z0-9]{1,7}-\d{3}):\s+.+$/mu)?.[1];
  if (!headingId || headingId !== filenameId) {
    errors.push(issue("TASK_ID_MISMATCH", label, `Filename ID ${filenameId} must match the H1 task ID.`));
  }
  if (/^\*\*(?:Status|Owner|Depends on):\*\*/imu.test(source)) {
    errors.push(issue("COORDINATION_DUPLICATED", label, "Status, owner, and dependencies belong only in README.md."));
  }
  for (const heading of ["Outcome", "Contract", "Proof-First Checklist", "Acceptance Criteria", "Evidence Destination"]) {
    if (meaningfulSection(extractSection(source, heading)).length < 8) {
      errors.push(issue("SECTION_EMPTY", label, `Section ## ${heading} must contain a concrete contract.`));
    }
  }
  return {
    id: headingId ?? filenameId,
    filename,
    source,
    designContracts: extractIds(extractSection(source, "Design Contracts"), /\bD-\d{3}\b/gu),
    exclusiveFiles: extractPathEntries(extractSection(source, "File Ownership")),
    sharedFiles: extractPathEntries(extractSection(source, "Shared Files")),
  };
}

function validateTaskIndex(table, records, errors) {
  const files = new Map(records.map((record) => [record.id, record]));
  for (const id of table.keys()) {
    if (!files.has(id)) errors.push(issue("TASK_FILE_MISSING", "README.md", `Task ${id} has no stable task file.`));
  }
  for (const record of records) {
    if (!table.has(record.id)) errors.push(issue("TASK_NOT_INDEXED", `tasks/${record.filename}`, `Task ${record.id} is absent from README.md.`));
  }
}

function validateDependencies(table, errors) {
  for (const task of table.values()) {
    for (const dependency of task.dependencies) {
      if (!TASK_ID.test(dependency) || !table.has(dependency)) {
        errors.push(issue("DEPENDENCY_MISSING", "README.md", `${task.id} depends on unknown task ${dependency}.`));
      }
      if (dependency === task.id) errors.push(issue("DEPENDENCY_SELF", "README.md", `${task.id} cannot depend on itself.`));
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, trail) => {
    if (visiting.has(id)) {
      errors.push(issue("DEPENDENCY_CYCLE", "README.md", `Dependency cycle: ${[...trail, id].join(" -> ")}`));
      return;
    }
    if (visited.has(id) || !table.has(id)) return;
    visiting.add(id);
    for (const dependency of table.get(id).dependencies) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of table.keys()) visit(id, []);
}

function validateDesignCoverage(design, records, errors) {
  const contracts = extractIds(extractSection(design, "Design Contracts"), /\bD-\d{3}\b/gu);
  if (contracts.size === 0) errors.push(issue("DESIGN_CONTRACTS_EMPTY", "design.md", "Define at least one stable D-### design contract."));
  const mapped = new Set(records.flatMap((record) => [...record.designContracts]));
  for (const contract of contracts) {
    if (!mapped.has(contract)) errors.push(issue("DESIGN_CONTRACT_UNMAPPED", "design.md", `${contract} is not mapped to any task.`));
  }
  for (const contract of mapped) {
    if (!contracts.has(contract)) errors.push(issue("DESIGN_CONTRACT_UNKNOWN", "tasks/", `${contract} is referenced by a task but absent from design.md.`));
  }
}

function validateOwnership(records, errors) {
  const owners = new Map();
  for (const record of records) {
    for (const filename of record.exclusiveFiles) {
      const entries = owners.get(filename) ?? [];
      entries.push({ id: record.id, shared: false });
      owners.set(filename, entries);
    }
    for (const filename of record.sharedFiles) {
      const entries = owners.get(filename) ?? [];
      entries.push({ id: record.id, shared: true });
      owners.set(filename, entries);
    }
  }
  for (const [filename, entries] of owners) {
    if (entries.length > 1 && entries.some((entry) => !entry.shared)) {
      errors.push(issue("FILE_OWNERSHIP_OVERLAP", "tasks/", `${filename} overlaps across ${entries.map((entry) => entry.id).join(", ")} without being shared by every owner.`));
    }
  }
}

function validateFinalVerification(table, records, errors) {
  const candidates = records.filter((record) => /final[ -]verification/iu.test(record.source));
  if (candidates.length !== 1) {
    errors.push(issue("FINAL_VERIFICATION_REQUIRED", "tasks/", "Define exactly one final verification task."));
    return;
  }
  const task = table.get(candidates[0].id);
  if (!task || task.dependencies.length === 0) {
    errors.push(issue("FINAL_VERIFICATION_DEPENDENCIES", "README.md", "Final verification must depend on implementation tasks."));
  }
}

function extractSection(source, heading) {
  const match = source.match(new RegExp(`^## ${escapeRegExp(heading)}\\s*\\r?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "mu"));
  return match?.[1] ?? "";
}

function meaningfulSection(section) {
  return section.replace(/[\s`*#|\[\]()-]/gu, "").trim();
}

function extractIds(source, pattern) {
  return new Set(source.match(pattern) ?? []);
}

function extractPathEntries(section) {
  const paths = new Set();
  for (const match of section.matchAll(/`([^`]+)`/gu)) {
    const value = match[1].trim().replace(/\\/gu, "/");
    if (value && !/^none\b/iu.test(value)) paths.add(value);
  }
  return paths;
}

function issue(code, pathValue, message) {
  return { code, path: pathValue, message };
}

function inputError(message) {
  const error = new Error(message);
  error.code = "WORKPACK_INPUT_INVALID";
  return error;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
