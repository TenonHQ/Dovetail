// Tests for filesystem-safe folder naming.
//
// Dovetail names each record's folder after its ServiceNow display name. Windows
// forbids `< > : " | ? * \ /`, a trailing space, and a trailing dot in a path
// component, so a record named "Email Status Change " (trailing space) or an ACL
// named "x_cadso_work_task.*" cannot be checked out on Windows. toSafeFolderName
// falls back to the always-safe sys_id for such names; normalizeManifestKeys keeps
// the on-disk folder name (record.name) equal to the manifest key push looks up by.

import { SN } from "@tenonhq/dovetail-types";
import { toSafeFolderName, normalizeManifestKeys } from "../appUtils";

const rec = (name: string, sys_id: string): SN.MetaRecord => ({
  name,
  sys_id,
  files: [{ name: "metaData", type: "json" }],
});

describe("toSafeFolderName", () => {
  it("leaves a safe display name unchanged", () => {
    expect(toSafeFolderName(rec("Send Email", "abc123"))).toBe("Send Email");
    expect(toSafeFolderName(rec("Prevent delete - WorkGroup", "abc123"))).toBe(
      "Prevent delete - WorkGroup",
    );
  });

  it("falls back to sys_id for a trailing space", () => {
    expect(toSafeFolderName(rec("Email Status Change ", "fefb8758"))).toBe("fefb8758");
  });

  it("falls back to sys_id for a trailing dot", () => {
    expect(toSafeFolderName(rec("weird.", "sid1"))).toBe("sid1");
  });

  it("falls back to sys_id for each Windows-illegal character", () => {
    const illegal = ["<", ">", ":", '"', "|", "?", "*", "\\", "/"];
    illegal.forEach((ch) => {
      expect(toSafeFolderName(rec("name" + ch + "x", "sidX"))).toBe("sidX");
    });
  });

  it("treats the wildcard ACL name as unsafe", () => {
    expect(toSafeFolderName(rec("x_cadso_work_task.*", "aclsid"))).toBe("aclsid");
  });

  it("falls back to sys_id for an empty name", () => {
    expect(toSafeFolderName(rec("", "emptysid"))).toBe("emptysid");
  });
});

describe("normalizeManifestKeys", () => {
  const buildManifest = (records: SN.MetaRecord[]): SN.AppManifest => {
    const byKey: SN.TableConfigRecords = {};
    records.forEach((r) => {
      byKey[r.sys_id] = r; // simulate a server manifest keyed by sys_id
    });
    return { scope: "x_cadso_test", tables: { sys_script: { records: byKey } } };
  };

  it("keys unsafe records by sys_id and safe records by name", () => {
    const manifest = buildManifest([
      rec("Send Email", "safe1"),
      rec("Email Status Change ", "fefb8758330ede107b18bc534d5c7bfb"),
      rec("x_cadso_work_task.*", "acl9999"),
    ]);

    normalizeManifestKeys(manifest);
    const keys = Object.keys(manifest.tables.sys_script.records);

    expect(keys).toContain("Send Email");
    expect(keys).toContain("fefb8758330ede107b18bc534d5c7bfb");
    expect(keys).toContain("acl9999");
    expect(keys).not.toContain("Email Status Change ");
    expect(keys).not.toContain("x_cadso_work_task.*");
  });

  it("keeps record.name === manifest key for every record (push invariant)", () => {
    const manifest = buildManifest([
      rec("Send Email", "safe1"),
      rec("Email Status Change ", "unsafe1"),
      rec("h:extended", "unsafe2"),
    ]);

    normalizeManifestKeys(manifest);
    const records = manifest.tables.sys_script.records;
    Object.keys(records).forEach((key) => {
      expect(records[key].name).toBe(key);
    });
  });

  it("preserves sys_id so push can still resolve the record", () => {
    const manifest = buildManifest([rec("Email Status Change ", "fefb8758")]);
    normalizeManifestKeys(manifest);
    const record = manifest.tables.sys_script.records["fefb8758"];
    expect(record).toBeDefined();
    expect(record.sys_id).toBe("fefb8758");
  });

  it("disambiguates duplicate folder names with a sys_id suffix", () => {
    const manifest = buildManifest([
      rec("Duplicate", "1111111111111111"),
      rec("Duplicate", "2222222222222222"),
    ]);

    normalizeManifestKeys(manifest);
    const keys = Object.keys(manifest.tables.sys_script.records);

    expect(keys).toContain("Duplicate");
    expect(keys).toContain("Duplicate (22222222)");
    // invariant still holds for the suffixed record
    expect(manifest.tables.sys_script.records["Duplicate (22222222)"].name).toBe(
      "Duplicate (22222222)",
    );
  });
});
