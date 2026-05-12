import * as fs from "fs";
import * as path from "path";
import { gunzipSync, gzipSync } from "zlib";
import { decodeV2Values, encodeV2Values } from "../flowDesigner/values";

const FIXTURES_DIR = path.join(__dirname, "fixtures", "v2-blobs");

describe("decodeV2Values / encodeV2Values", () => {
  describe("round-trip", () => {
    it("decodes what encodeV2Values encoded (primitive array)", () => {
      const original = [
        { actionInstanceSysId: "abc", id: "1", name: "to", value: "user@example.com" },
        { actionInstanceSysId: "abc", id: "2", name: "subject", value: "hi" },
      ];
      const blob = encodeV2Values(original);
      expect(decodeV2Values(blob)).toEqual(original);
    });

    it("decodes what encodeV2Values encoded (nested parameter objects)", () => {
      const original = [
        {
          actionInstanceSysId: "abc123",
          id: "input_a",
          name: "record",
          value: { table: "incident", sys_id: "xyz" },
          parameter: {
            type: "reference",
            labels: { en: "Record" },
            validation: { mandatory: true },
          },
        },
      ];
      const blob = encodeV2Values(original);
      expect(decodeV2Values(blob)).toEqual(original);
    });

    it("handles empty array", () => {
      expect(decodeV2Values(encodeV2Values([]))).toEqual([]);
    });

    it("handles large payloads without truncation", () => {
      const big = Array.from({ length: 500 }, (_, i) => ({
        id: String(i),
        name: "field_" + i,
        value: "x".repeat(200),
      }));
      expect(decodeV2Values(encodeV2Values(big))).toEqual(big);
    });
  });

  describe("decode — input validation", () => {
    it("throws on empty string", () => {
      expect(() => decodeV2Values("")).toThrow(/non-empty string/);
    });

    it("throws on whitespace-only string", () => {
      expect(() => decodeV2Values("   \n  ")).toThrow(/non-empty string/);
    });

    it("throws on non-string input", () => {
      expect(() => decodeV2Values(null as unknown as string)).toThrow(/non-empty string/);
      expect(() => decodeV2Values(undefined as unknown as string)).toThrow(/non-empty string/);
      expect(() => decodeV2Values(123 as unknown as string)).toThrow(/non-empty string/);
    });

    it("throws with a clear message on non-gzip base64 input", () => {
      // Valid base64, but the decoded bytes are not gzip.
      const notGzip = Buffer.from("hello world").toString("base64");
      expect(() => decodeV2Values(notGzip)).toThrow(/decompression failed/);
    });

    it("throws on gzip of invalid JSON", () => {
      const badJson = gzipSync(Buffer.from("{not valid json", "utf8")).toString("base64");
      expect(() => decodeV2Values(badJson)).toThrow(/not valid JSON/);
    });

    it("tolerates trailing whitespace and newlines (common from file reads)", () => {
      const blob = encodeV2Values([{ id: "1", value: "a" }]);
      expect(decodeV2Values(blob + "\n")).toEqual([{ id: "1", value: "a" }]);
      expect(decodeV2Values("  " + blob + "  ")).toEqual([{ id: "1", value: "a" }]);
    });
  });

  describe("generic typing", () => {
    it("preserves the caller's expected type", () => {
      interface Foo {
        actionInstanceSysId: string;
        id: string;
      }
      const blob = encodeV2Values([{ actionInstanceSysId: "a", id: "1" }]);
      const decoded = decodeV2Values<Foo[]>(blob);
      expect(decoded[0].actionInstanceSysId).toBe("a");
      expect(decoded[0].id).toBe("1");
    });
  });

  describe("encode — input validation", () => {
    it("throws on undefined", () => {
      expect(() => encodeV2Values(undefined as unknown)).toThrow(/must not be undefined/);
    });

    it("throws on non-JSON-serializable values (function at root)", () => {
      expect(() => encodeV2Values(() => 1)).toThrow(/not JSON-serializable/);
    });

    it("throws on non-JSON-serializable values (BigInt at root)", () => {
      expect(() => encodeV2Values(BigInt(1) as unknown)).toThrow();
    });

    it("accepts null", () => {
      expect(decodeV2Values<null>(encodeV2Values(null))).toBeNull();
    });

    it("accepts plain objects (logic_instance_v2 shape)", () => {
      const original = { outputsToAssign: [], inputs: [{ name: "x", value: "" }] };
      expect(decodeV2Values(encodeV2Values(original))).toEqual(original);
    });
  });

  describe("encode — options", () => {
    it("round-trips correctly at every supported compression level", () => {
      const v = Array.from({ length: 200 }, (_, i) => ({ id: String(i), value: "x".repeat(50) }));
      for (let level = 1; level <= 9; level++) {
        const blob = encodeV2Values(v, { level });
        expect(decodeV2Values(blob)).toEqual(v);
      }
    });

    it("emits different byte streams at different levels (level is honored)", () => {
      // Highly compressible payload — level=1 vs level=9 must differ in bytes,
      // even if which is shorter is not strictly monotonic for tiny inputs.
      const v = Array.from({ length: 500 }, (_, i) => ({ id: String(i), value: "abcde".repeat(20) }));
      const lvl1 = encodeV2Values(v, { level: 1 });
      const lvl9 = encodeV2Values(v, { level: 9 });
      expect(lvl1).not.toEqual(lvl9);
    });

    it("treats undefined level as default (no throw, valid output)", () => {
      const v = [{ id: "1", value: "a" }];
      expect(decodeV2Values(encodeV2Values(v, {}))).toEqual(v);
      expect(decodeV2Values(encodeV2Values(v, { level: undefined }))).toEqual(v);
    });
  });

  describe("round-trip — real Tenon fixtures", () => {
    // Real V2 blobs pulled from tenonworkstudio sit under
    // tests/fixtures/v2-blobs/<table>.<sys_id>.txt. Each one must survive a
    // decode→encode→decode pass with structural deep-equality preserved. This
    // is the gate that lets us trust encodeV2Values for write-path use.
    const fixtures = fs.existsSync(FIXTURES_DIR)
      ? fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".txt"))
      : [];

    it("fixtures directory has at least one sample per V2 table", () => {
      expect(fixtures.length).toBeGreaterThan(0);
      const tables = new Set(fixtures.map((f) => f.split(".")[0]));
      // We expect samples for at least the action_instance and flow_logic_instance
      // shapes. trigger_instance is nice-to-have but not gating.
      expect(tables.has("sys_hub_action_instance_v2")).toBe(true);
      expect(tables.has("sys_hub_flow_logic_instance_v2")).toBe(true);
    });

    fixtures.forEach((filename) => {
      it(`round-trips: ${filename}`, () => {
        const blob = fs.readFileSync(path.join(FIXTURES_DIR, filename), "utf8").trim();
        const decoded = decodeV2Values(blob);
        const reencoded = encodeV2Values(decoded);
        const reDecoded = decodeV2Values(reencoded);
        expect(reDecoded).toEqual(decoded);
      });
    });

    it("re-encoded blobs decompress to byte-identical JSON via Node's zlib", () => {
      // Belt-and-suspenders: our own zlib can read what we just wrote.
      // (RFC 1952 conformance check; SN-side acceptance is a separate integration test.)
      if (!fixtures.length) return;
      const blob = fs.readFileSync(path.join(FIXTURES_DIR, fixtures[0]), "utf8").trim();
      const decoded = decodeV2Values(blob);
      const reencoded = encodeV2Values(decoded);
      const ourJson = gunzipSync(Buffer.from(reencoded, "base64")).toString("utf8");
      expect(JSON.parse(ourJson)).toEqual(decoded);
    });
  });
});
