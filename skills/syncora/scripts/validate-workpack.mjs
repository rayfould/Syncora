#!/usr/bin/env node

import { validateWorkpack } from "./lib/workpack-validator.mjs";

function parseArguments(argumentsList) {
  const options = { workspace: undefined, workpack: undefined, format: "text" };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!["--workspace", "--workpack", "--format"].includes(argument)) {
      throw Object.assign(new Error(`Unknown option: ${argument}`), { code: "WORKPACK_INPUT_INVALID" });
    }
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) {
      throw Object.assign(new Error(`${argument} requires a value.`), { code: "WORKPACK_INPUT_INVALID" });
    }
    index += 1;
    if (argument === "--workspace") options.workspace = value;
    if (argument === "--workpack") options.workpack = value;
    if (argument === "--format") {
      if (!["text", "json"].includes(value)) {
        throw Object.assign(new Error("--format must be text or json."), { code: "WORKPACK_INPUT_INVALID" });
      }
      options.format = value;
    }
  }
  return options;
}

function renderText(report) {
  const lines = [
    report.ok ? "WORKPACK_READY" : "WORKPACK_INVALID",
    `path: ${report.workpack}`,
    `tasks: ${report.summary.tasks}`,
    `design-contracts: ${report.summary.designContracts}`,
    `errors: ${report.summary.errors}`,
  ];
  for (const error of report.errors) lines.push(`${error.code} ${error.path}: ${error.message}`);
  return `${lines.join("\n")}\n`;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const report = await validateWorkpack(options);
  process.stdout.write(options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  const payload = {
    ok: false,
    error: {
      code: typeof error?.code === "string" ? error.code : "WORKPACK_VALIDATION_FAILED",
      message: error instanceof Error ? error.message : String(error),
    },
  };
  const json = process.argv.includes("--format") && process.argv[process.argv.indexOf("--format") + 1] === "json";
  process.stderr.write(json ? `${JSON.stringify(payload, null, 2)}\n` : `${payload.error.code}: ${payload.error.message}\n`);
  process.exitCode = 1;
}
