import { SyncoraError } from "./cli.mjs";

export const DEFAULT_MAINTENANCE_CONFIG = Object.freeze({
  mode: "hybrid",
  fullValidationEveryActivations: 50,
  fullValidationMaxAgeHours: 168,
});
export const SYNCORA_CONFIG_SCHEMA_VERSION = 1;

function invalid(message) {
  throw new SyncoraError("CONFIG001", message);
}

export function normalizeMaintenanceConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    invalid("Syncora configuration must be a JSON object.");
  }

  const supplied = config.maintenance;
  if (supplied === undefined) return { ...DEFAULT_MAINTENANCE_CONFIG };
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    invalid("Syncora maintenance configuration must be an object.");
  }
  const allowedKeys = new Set([
    "mode",
    "fullValidationEveryActivations",
    "fullValidationMaxAgeHours",
  ]);
  const unknownKeys = Object.keys(supplied).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    invalid(`Unknown maintenance configuration field: ${unknownKeys.sort()[0]}`);
  }

  const mode = supplied.mode ?? DEFAULT_MAINTENANCE_CONFIG.mode;
  if (mode !== "hybrid") {
    invalid("maintenance.mode must be \"hybrid\".");
  }

  const fullValidationEveryActivations =
    supplied.fullValidationEveryActivations ??
    DEFAULT_MAINTENANCE_CONFIG.fullValidationEveryActivations;
  if (
    !Number.isInteger(fullValidationEveryActivations) ||
    fullValidationEveryActivations < 1 ||
    fullValidationEveryActivations > 10_000
  ) {
    invalid(
      "maintenance.fullValidationEveryActivations must be an integer from 1 through 10000.",
    );
  }

  const fullValidationMaxAgeHours =
    supplied.fullValidationMaxAgeHours ??
    DEFAULT_MAINTENANCE_CONFIG.fullValidationMaxAgeHours;
  if (
    typeof fullValidationMaxAgeHours !== "number" ||
    !Number.isFinite(fullValidationMaxAgeHours) ||
    fullValidationMaxAgeHours <= 0 ||
    fullValidationMaxAgeHours > 8_760
  ) {
    invalid(
      "maintenance.fullValidationMaxAgeHours must be a finite number greater than 0 and no greater than 8760.",
    );
  }

  return {
    mode,
    fullValidationEveryActivations,
    fullValidationMaxAgeHours,
  };
}

export function normalizeSyncoraRuntimeConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    invalid("Syncora configuration must be a JSON object.");
  }
  if (!Number.isInteger(config.schemaVersion) || config.schemaVersion < 1) {
    invalid("Syncora config schemaVersion must be a positive integer.");
  }
  if (config.schemaVersion > SYNCORA_CONFIG_SCHEMA_VERSION) {
    throw new SyncoraError(
      "SCHEMA001",
      `Config schema ${config.schemaVersion} is newer than supported schema ${SYNCORA_CONFIG_SCHEMA_VERSION}.`,
    );
  }
  return {
    config,
    maintenance: normalizeMaintenanceConfig(config),
  };
}
