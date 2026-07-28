// Tests for stampMetadataContent — the writer that finalizes each record's
// metaData.json before it lands on disk.
//
// The contract is determinism: the same record must produce the same bytes on
// any instance, from any machine, on every pull. Three on-disk-stability
// concerns are covered:
//   1. No generation-time value survives. `_lastUpdatedOn` is deleted outright —
//      it duplicated sys_updated_on.value exactly, and its no-sys_updated_on
//      branch stamped a wall-clock that rewrote the file on every pull.
//   2. _record_link is rewritten to an instance-relative path. The CADSO metadata
//      endpoint returns an absolute URL (https://<instance>.service-now.com/...);
//      persisting the host makes the artifact instance-bound and dirties every
//      file on a re-pull from a different instance. Stripping any *.service-now.com
//      host keeps the diff to genuine schema changes.
//   3. display_value is stripped — it is resolved live server-side, so renaming
//      a referenced record re-churns every file pointing at it.

import { SN } from "@tenonhq/dovetail-types";
import { EMPTY_METADATA_CONTENT, stampMetadataContent } from "../appUtils";

// Matches an ISO-8601 wall-clock stamp (what `new Date().toISOString()` emits).
const ISO_STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const metaFile = (content: object): SN.File => ({
  name: "metaData",
  type: "json",
  content: JSON.stringify(content),
});

const parse = (file: SN.File): any => JSON.parse(file.content as string);

describe("stampMetadataContent — _record_link host stripping", () => {
  it("strips the configured workstudio host, leaving the relative path", () => {
    const out = stampMetadataContent(
      metaFile({
        sys_updated_on: { value: "2025-08-21 17:09:02" },
        _record_link:
          "https://tenonworkstudio.service-now.com/sys_hub_action_input.do?sys_id=85de623c33ef2a107b18bc534d5c7b92",
      }),
    );
    expect(parse(out)._record_link).toBe(
      "/sys_hub_action_input.do?sys_id=85de623c33ef2a107b18bc534d5c7b92",
    );
  });

  it("strips any *.service-now.com host (instance-portable)", () => {
    for (const host of ["tenonworkshop", "tenon", "tenonworkbench"]) {
      const out = stampMetadataContent(
        metaFile({
          _record_link: `https://${host}.service-now.com/x_cadso_core_setting.do?sys_id=abc`,
        }),
      );
      expect(parse(out)._record_link).toBe("/x_cadso_core_setting.do?sys_id=abc");
    }
  });

  it("leaves an already-relative _record_link untouched (idempotent)", () => {
    const out = stampMetadataContent(
      metaFile({ _record_link: "/sys_hub_action_input.do?sys_id=abc" }),
    );
    expect(parse(out)._record_link).toBe("/sys_hub_action_input.do?sys_id=abc");
  });

  it("leaves records without a _record_link unchanged", () => {
    const out = stampMetadataContent(
      metaFile({ sys_updated_on: { value: "2025-08-21 17:09:02" } }),
    );
    expect(parse(out)._record_link).toBeUndefined();
  });

  it("ignores a non-string _record_link rather than throwing", () => {
    const out = stampMetadataContent(metaFile({ _record_link: null }));
    expect(parse(out)._record_link).toBeNull();
  });

  it("strips the host while leaving the record's own sys_updated_on intact", () => {
    const out = stampMetadataContent(
      metaFile({
        sys_updated_on: { value: "2025-08-21 17:09:02" },
        _record_link: "https://tenonworkstudio.service-now.com/incident.do?sys_id=1",
      }),
    );
    const parsed = parse(out);
    expect(parsed.sys_updated_on).toEqual({ value: "2025-08-21 17:09:02" });
    expect(parsed._record_link).toBe("/incident.do?sys_id=1");
  });

  it("passes through non-metaData files verbatim", () => {
    const script: SN.File = { name: "script", type: "js", content: "var x = 1;" };
    expect(stampMetadataContent(script)).toEqual(script);
  });
});

describe("stampMetadataContent — no generation-time values", () => {
  it("never writes _lastUpdatedOn, even when sys_updated_on is present", () => {
    const out = stampMetadataContent(
      metaFile({ sys_updated_on: { value: "2025-08-21 17:09:02" } }),
    );
    expect(parse(out)._lastUpdatedOn).toBeUndefined();
  });

  it("deletes a pre-existing _lastUpdatedOn so a re-stamp settles legacy content", () => {
    // A branch pulled before this change carries the key on disk. Re-stamping
    // has to remove it, otherwise the stale value persists forever and the
    // mirror never converges.
    const out = stampMetadataContent(
      metaFile({
        sys_updated_on: { value: "2025-08-21 17:09:02" },
        _lastUpdatedOn: "2025-08-21 17:09:02",
        _record_link: "/incident.do?sys_id=1",
      }),
    );
    const parsed = parse(out);
    expect(parsed._lastUpdatedOn).toBeUndefined();
    expect(parsed._record_link).toBe("/incident.do?sys_id=1");
  });

  it("emits no wall-clock stamp when sys_updated_on is absent", () => {
    // The old fallback stamped new Date().toISOString() here, which is what
    // made every pull dirty the record.
    const out = stampMetadataContent(metaFile({ name: { value: "no audit columns" } }));
    expect(out.content).not.toMatch(ISO_STAMP);
    expect(parse(out)._lastUpdatedOn).toBeUndefined();
  });

  it("writes the deterministic placeholder for empty content", () => {
    const out = stampMetadataContent({ name: "metaData", type: "json", content: "" });
    expect(out.content).toBe(EMPTY_METADATA_CONTENT);
    expect(out.content).not.toMatch(ISO_STAMP);
  });

  it("produces identical bytes across repeated runs (the whole point)", () => {
    const server = {
      sys_updated_on: { value: "2025-08-21 17:09:02", display_value: "2025-08-21 10:09:02" },
      action: { value: "abc", display_value: "Some Record Name" },
      _record_link: "https://tenonworkstudio.service-now.com/incident.do?sys_id=1",
      _lastUpdatedOn: "2025-08-21 17:09:02",
    };
    // Two independent pulls of an unchanged record, one re-stamp of the result.
    const first = stampMetadataContent(metaFile(server));
    const second = stampMetadataContent(metaFile(server));
    const restamped = stampMetadataContent(first);
    expect(second.content).toBe(first.content);
    expect(restamped.content).toBe(first.content);
  });

  it("leaves non-object JSON alone rather than throwing", () => {
    const bare: SN.File = { name: "metaData", type: "json", content: '"just a string"' };
    expect(stampMetadataContent(bare)).toEqual(bare);
    const arr: SN.File = { name: "metaData", type: "json", content: "[1,2,3]" };
    expect(stampMetadataContent(arr)).toEqual(arr);
  });
});

describe("stampMetadataContent — display_value stripping", () => {
  it("drops display_value from field pairs, keeping value", () => {
    const out = stampMetadataContent(
      metaFile({
        sys_updated_on: { value: "2025-08-21 17:09:02" },
        action: {
          value: "85de623c33ef2a107b18bc534d5c7b92",
          display_value: "Parse hashes for to_addresses",
        },
      }),
    );
    const parsed = parse(out);
    expect(parsed.action).toEqual({
      value: "85de623c33ef2a107b18bc534d5c7b92",
    });
    expect(parsed.action.display_value).toBeUndefined();
  });

  it("strips every field's display_value in one pass", () => {
    const out = stampMetadataContent(
      metaFile({
        a: { value: "1", display_value: "One" },
        b: { value: "2", display_value: "Two" },
      }),
    );
    const parsed = parse(out);
    expect(parsed.a).toEqual({ value: "1" });
    expect(parsed.b).toEqual({ value: "2" });
  });

  it("leaves value-only fields and string keys untouched", () => {
    const out = stampMetadataContent(
      metaFile({
        sys_updated_on: { value: "2025-08-21 17:09:02" },
        _record_link: "/incident.do?sys_id=1",
        name: { value: "plain" },
      }),
    );
    const parsed = parse(out);
    expect(parsed.sys_updated_on).toEqual({ value: "2025-08-21 17:09:02" });
    expect(parsed.name).toEqual({ value: "plain" });
    expect(parsed._record_link).toBe("/incident.do?sys_id=1");
  });

  it("is idempotent — a display-value-free record stays byte-identical", () => {
    const clean = {
      sys_updated_on: { value: "2025-08-21 17:09:02" },
      action: { value: "abc" },
      _record_link: "/incident.do?sys_id=1",
    };
    const first = stampMetadataContent(metaFile(clean));
    const second = stampMetadataContent(first);
    expect(second.content).toBe(first.content);
  });
});
