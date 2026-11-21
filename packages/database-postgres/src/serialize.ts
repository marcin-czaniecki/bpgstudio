import type { CellValue } from "@bpg/database-core";

export const MAX_CELL_CHARS = 10_000;
const TRUNCATION_MARK = "…[truncated]";

function clip(text: string): string {
  return text.length > MAX_CELL_CHARS
    ? `${text.slice(0, MAX_CELL_CHARS)}${TRUNCATION_MARK}`
    : text;
}

/**
 * Converts a driver value into something JSON-safe that the renderer can show.
 * int8/numeric arrive from `pg` as strings and stay that way (no precision loss).
 */
export function toCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
      return clip(value);
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "object":
      break;
    default:
      return clip(String(value));
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    // Hex is 2 chars per byte: only convert what can survive clipping.
    const head = value.subarray(0, Math.ceil(MAX_CELL_CHARS / 2) + 1);
    return clip(`\\x${head.toString("hex")}`);
  }
  try {
    return clip(JSON.stringify(value) ?? "null");
  } catch {
    return "[unserializable value]";
  }
}
