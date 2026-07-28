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

// display_value handling is SELECTIVE, not a blanket strip. The rule was chosen
// from a measurement of 43,990 pairs in the real servicenow-files mirror; each
// test below names the category and why it falls on the side it does.
describe("stampMetadataContent — display_value DROPPED where it is churn", () => {
  it("drops it when it is identical to value (zero information, any size)", () => {
    const out = stampMetadataContent(
      metaFile({
        name: { value: "UIFilterApiMS", display_value: "UIFilterApiMS" },
      }),
    );
    expect(parse(out).name).toEqual({ value: "UIFilterApiMS" });
  });

  it("drops identical pairs on large text fields too (script, composition)", () => {
    // 619 pairs but ~3.7 MB of the corpus — the bulk of the file weight.
    const big = "var x = 1;\n".repeat(60);
    const out = stampMetadataContent(
      metaFile({ script: { value: big, display_value: big } }),
    );
    expect(parse(out).script).toEqual({ value: big });
  });

  it("drops it on datetime fields — display_value is the PULLER's timezone", () => {
    // Measured 1,706 TZ-shifted out of 1,706. `value` is UTC; display_value is
    // rendered in the local timezone of whoever ran the pull, so keeping it
    // makes the bytes depend on which laptop synced.
    const out = stampMetadataContent(
      metaFile({
        sys_updated_on: { value: "2026-04-29 14:38:51", display_value: "2026-04-29 07:38:51" },
        sys_created_on: { value: "2026-04-29 14:38:51", display_value: "2026-04-29 07:38:51" },
      }),
    );
    const parsed = parse(out);
    expect(parsed.sys_updated_on).toEqual({ value: "2026-04-29 14:38:51" });
    expect(parsed.sys_created_on).toEqual({ value: "2026-04-29 14:38:51" });
  });

  it("drops it on a date-only value as well", () => {
    const out = stampMetadataContent(
      metaFile({ start_date: { value: "2026-04-29", display_value: "29-04-2026" } }),
    );
    expect(parse(out).start_date).toEqual({ value: "2026-04-29" });
  });

  it("drops it on sys_scope / sys_package — one app rename churns the whole tree", () => {
    // Present in ~0.95 records per file. The scope is already obvious from the
    // folder path (src/Work/, src/Core/), so the value is low and the blast
    // radius is every file in the mirror.
    const out = stampMetadataContent(
      metaFile({
        sys_scope: {
          value: "4e4449a5475c255085d19fd8036d43a0",
          display_value: "Tenon Marketing Work Management",
        },
        sys_package: {
          value: "4e4449a5475c255085d19fd8036d43a0",
          display_value: "Tenon Marketing Work Management",
        },
      }),
    );
    const parsed = parse(out);
    expect(parsed.sys_scope).toEqual({ value: "4e4449a5475c255085d19fd8036d43a0" });
    expect(parsed.sys_package).toEqual({ value: "4e4449a5475c255085d19fd8036d43a0" });
  });

  it("treats null and \"\" as identical rather than writing \"null\"", () => {
    const out = stampMetadataContent(
      metaFile({ controlled_by_refs: { value: null, display_value: "" } }),
    );
    expect(parse(out).controlled_by_refs).toEqual({ value: null });
  });
});

describe("stampMetadataContent — display_value KEPT where it is information", () => {
  it("keeps a reference's human name (the sys_id -> name mapping)", () => {
    // This is the readable mapping Documentation/Dovetail-Development.md
    // documents grepping to walk the record graph. A blanket strip destroyed it.
    const out = stampMetadataContent(
      metaFile({
        action: {
          value: "85de623c33ef2a107b18bc534d5c7b92",
          display_value: "Parse hashes for to_addresses",
        },
      }),
    );
    expect(parse(out).action).toEqual({
      value: "85de623c33ef2a107b18bc534d5c7b92",
      display_value: "Parse hashes for to_addresses",
    });
  });

  it("keeps boolean renderings (0 -> false)", () => {
    const out = stampMetadataContent(
      metaFile({
        active: { value: "1", display_value: "true" },
        client_callable: { value: "0", display_value: "false" },
      }),
    );
    const parsed = parse(out);
    expect(parsed.active).toEqual({ value: "1", display_value: "true" });
    expect(parsed.client_callable).toEqual({ value: "0", display_value: "false" });
  });

  it("keeps choice / class labels", () => {
    const out = stampMetadataContent(
      metaFile({
        sys_class_name: { value: "sys_security_acl", display_value: "Access Control" },
        access: { value: "package_private", display_value: "This application scope only" },
      }),
    );
    const parsed = parse(out);
    expect(parsed.sys_class_name.display_value).toBe("Access Control");
    expect(parsed.access.display_value).toBe("This application scope only");
  });
});

describe("stampMetadataContent — display_value determinism", () => {
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

  it("is idempotent across a full mixed record — kept pairs survive a re-stamp", () => {
    // The failure mode this guards: a rule that keeps a pair on pass 1 but drops
    // it on pass 2 would churn forever. Run a record carrying every category.
    const mixed = {
      sys_updated_on: { value: "2026-04-29 14:38:51", display_value: "2026-04-29 07:38:51" },
      sys_scope: { value: "4e4449a5", display_value: "Tenon Marketing Work Management" },
      sys_class_name: { value: "sys_security_acl", display_value: "Access Control" },
      active: { value: "1", display_value: "true" },
      action: { value: "85de623c", display_value: "Parse hashes" },
      name: { value: "same", display_value: "same" },
      _record_link: "https://tenonworkstudio.service-now.com/incident.do?sys_id=1",
    };
    const first = stampMetadataContent(metaFile(mixed));
    const second = stampMetadataContent(first);
    const third = stampMetadataContent(second);
    expect(second.content).toBe(first.content);
    expect(third.content).toBe(first.content);

    // And the kept set is exactly what we intend.
    const parsed = parse(first);
    expect(parsed.sys_updated_on.display_value).toBeUndefined();
    expect(parsed.sys_scope.display_value).toBeUndefined();
    expect(parsed.name.display_value).toBeUndefined();
    expect(parsed.sys_class_name.display_value).toBe("Access Control");
    expect(parsed.active.display_value).toBe("true");
    expect(parsed.action.display_value).toBe("Parse hashes");
  });
});
