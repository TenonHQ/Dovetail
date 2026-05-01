import { gunzipSync, gzipSync, ZlibOptions } from "zlib";

/**
 * Shape of a single entry inside a decoded V2 `values` payload.
 * Documented via reverse engineering of real Tenon-shipped blobs;
 * ServiceNow does not publish a schema for this structure.
 *
 * Two top-level shapes are observed in the wild:
 *   - sys_hub_action_instance_v2.values / sys_hub_trigger_instance_v2.values
 *     decode to an ARRAY of entries (one per declared step input).
 *   - sys_hub_flow_logic_instance_v2.values
 *     decodes to an OBJECT (e.g. { outputsToAssign, inputs, ... }) whose
 *     internal `inputs` array follows the same per-entry shape.
 *
 * Real entries never contain `actionInstanceSysId` at the top level — the
 * link to the parent instance is the row's own primary key in
 * sys_hub_action_instance_v2.sys_id, not a denormalized field inside `values`.
 *
 * The interface is intentionally loose — Flow Designer stores rich,
 * step-type-specific extensions inside `parameter` and `children`. Round-trip
 * fidelity is the test gate; see tests/v2Values.test.ts.
 */
export interface V2ValueEntry {
  id?: string;
  name?: string;
  value?: unknown;
  displayValue?: unknown;
  children?: unknown;
  parameter?: {
    type?: string;
    labels?: unknown;
    validation?: unknown;
    [key: string]: unknown;
  };
  scriptActive?: boolean;
  [key: string]: unknown;
}

/** Options for encoding back to ServiceNow's V2 storage format. */
export interface EncodeV2ValuesOptions {
  /**
   * zlib compression level (1-9). Defaults to Node's zlib default.
   * Compression level does not affect round-trip equality — both Java's
   * Deflater and Node's zlib emit RFC 1952-compliant streams that the
   * other can decompress, regardless of level.
   */
  level?: number;
}

/**
 * Decode a ServiceNow V2 Flow Designer `values` blob.
 *
 * Source tables:
 *   - sys_hub_action_instance_v2.values
 *   - sys_hub_trigger_instance_v2.values
 *   - sys_hub_flow_logic_instance_v2.values
 *
 * Storage format: base64-encoded gzipped JSON.
 * Mirrors `GlideStringUtil.base64DecodeAsBytes()` + `GlideCompressionUtil.expandToString()`
 * + `JSON.parse` on the ServiceNow platform.
 *
 * Throws with a clear message if the blob is empty, not base64, or not gzip.
 */
export function decodeV2Values<T = V2ValueEntry[]>(blob: string): T {
  if (typeof blob !== "string" || blob.trim().length === 0) {
    throw new Error("decodeV2Values: blob must be a non-empty string");
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(blob.trim(), "base64");
  } catch (err) {
    throw new Error("decodeV2Values: blob is not valid base64");
  }
  let json: string;
  try {
    json = gunzipSync(buf).toString("utf8");
  } catch (err) {
    throw new Error(
      "decodeV2Values: decompression failed (input is not valid gzip after base64 decode)",
    );
  }
  try {
    return JSON.parse(json) as T;
  } catch (err) {
    throw new Error("decodeV2Values: decompressed body is not valid JSON");
  }
}

/**
 * Encode a V2 values payload back to ServiceNow's storage format.
 *
 * Inverse of decodeV2Values. The output's gzip envelope may differ byte-for-byte
 * from a Java-produced original (Deflater and zlib emit different but compatible
 * streams), but the decompressed JSON is identical content. Round-trip
 * fidelity is verified against real Tenon-shipped fixtures in
 * tests/v2Values.test.ts; SN-side acceptance is verified by the
 * `@tenonhq/sincronia-servicenow` flowDesigner write path.
 *
 * Throws when `value` is undefined or otherwise not JSON-serializable
 * (e.g. functions, BigInt). Anything that survives JSON.stringify will be
 * accepted; structural validity is the caller's responsibility.
 */
export function encodeV2Values(value: unknown, opts: EncodeV2ValuesOptions = {}): string {
  if (value === undefined) {
    throw new Error("encodeV2Values: value must not be undefined");
  }
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new Error(
      "encodeV2Values: value is not JSON-serializable (e.g. function or BigInt at the root)",
    );
  }
  const zlibOpts: ZlibOptions = {};
  if (opts.level !== undefined && opts.level !== null) {
    zlibOpts.level = opts.level;
  }
  return gzipSync(Buffer.from(json, "utf8"), zlibOpts).toString("base64");
}
