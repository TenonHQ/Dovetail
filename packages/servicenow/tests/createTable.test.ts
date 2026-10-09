import {
  createTable,
  projectTableGraph,
  buildColumnXml,
  normalizeColumns,
  resolveType,
  applyTableSaveOverlay,
  defaultAccessFlags,
  listEditKey,
  showInMenuKey,
  parseFormInputs,
  parseSysIdFromLocation,
  verifyColumnAttributes,
  type OverlaySpec,
  type NormalizedColumn
} from "../src/table";
import type { ServiceNowClient } from "../src/client";

function fakeClient(): ServiceNowClient {
  return {
    table: { query: async function () { return []; } },
    buildAgent: {
      runQuery: async function () { return []; },
      getTableSchema: async function () { return { fields: [], primary_key: "sys_id" }; }
    },
    claude: {
      createRecord: async function () { return { sys_id: "x" }; },
      pushWithUpdateSet: async function () { return { sys_id: "x" }; },
      currentUpdateSet: async function () { return { sys_id: "u", name: "u" }; },
      changeUpdateSet: async function () { return {}; },
      deleteRecord: async function () { return {}; }
    },
    attachment: {
      listFor: async function () { return []; },
      upload: async function () { return { sys_id: "att", file_name: "", content_type: "" }; },
      remove: async function () { return undefined; }
    },
    now: {
      get: async function () { return undefined; },
      post: async function () { return undefined; },
      put: async function () { return undefined; },
      delete: async function () { return undefined; },
      invoke: async function () { return { status: 200, body: {} }; }
    }
  } as ServiceNowClient;
}

describe("resolveType", function () {
  it("maps friendly 'string' to Studio's real string_full_utf8", function () {
    expect(resolveType("string")).toBe("string_full_utf8");
    expect(resolveType("String")).toBe("string_full_utf8");
  });
  it("passes internal types through unchanged", function () {
    expect(resolveType("string_full_utf8")).toBe("string_full_utf8");
    expect(resolveType("glide_date_time")).toBe("glide_date_time");
    expect(resolveType("choice")).toBe("choice");
  });
  it("throws on an unknown type", function () {
    expect(function () { resolveType("frobnicate"); }).toThrow(/unknown column type/);
  });
});

describe("normalizeColumns", function () {
  it("normalizes the HAR's 12 columns to their internal types", function () {
    var cols = normalizeColumns([
      { label: "Key", type: "string", max_length: 255 },
      { label: "Severity", type: "choice", max_length: 50 },
      { label: "First Seen On", type: "datetime" },
      { label: "Occurence Count", type: "integer", max_length: 5 }
    ]);
    expect(cols[0].type).toBe("string_full_utf8");
    expect(cols[0].maxLength).toBe("255");
    expect(cols[1].type).toBe("choice");
    expect(cols[2].type).toBe("glide_date_time");
    expect(cols[2].maxLength).toBe(""); // datetime carries no max_length
    expect(cols[3].type).toBe("integer");
  });
  it("rejects an empty list, a missing label, a dup label, and a ref without target", function () {
    expect(function () { normalizeColumns([]); }).toThrow(/at least one column/);
    expect(function () { normalizeColumns([{ label: "", type: "string" }]); }).toThrow(/missing a label/);
    expect(function () {
      normalizeColumns([{ label: "A", type: "string" }, { label: "a", type: "integer" }]);
    }).toThrow(/duplicate column/);
    expect(function () { normalizeColumns([{ label: "Owner", type: "reference" }]); }).toThrow(/reference target/);
  });
});

describe("buildColumnXml", function () {
  var cols: Array<NormalizedColumn> = [
    { label: "Key", type: "string_full_utf8", maxLength: "255", reference: "" },
    { label: "First Seen On", type: "glide_date_time", maxLength: "", reference: "" }
  ];
  it("wraps one <record operation=add> per column in a sys_dictionary record_update", function () {
    var xml = buildColumnXml(cols, ["aaaa", "bbbb"]);
    expect(xml.indexOf('<record_update table="sys_dictionary"')).toBe(0);
    expect((xml.match(/<record /g) || []).length).toBe(2);
    expect(xml).toContain('<record sys_id="aaaa" operation="add">');
    expect(xml).toContain("<display_value>Key</display_value>");
    expect(xml).toContain("<value>string_full_utf8</value>");
    expect(xml).toContain("<value>glide_date_time</value>");
    expect(xml).toContain("<value>NULL</value>"); // reference NULL
  });
  it("renders max_length as a display_value only for sized types", function () {
    var xml = buildColumnXml(cols, ["aaaa", "bbbb"]);
    expect(xml).toContain("<display_value>255</display_value>");
  });
  it("escapes XML-significant characters in labels", function () {
    var xml = buildColumnXml([{ label: "A & B <c>", type: "choice", maxLength: "", reference: "" }], ["z"]);
    expect(xml).toContain("A &amp; B &lt;c&gt;");
  });
  it("throws when sys_ids don't match column count", function () {
    expect(function () { buildColumnXml(cols, ["only-one"]); }).toThrow(/one sys_id per column/);
  });
});

describe("projectTableGraph", function () {
  it("reproduces the 36-record graph for a 12-column table with ACLs + role", function () {
    var g = projectTableGraph(12, true, true);
    expect(g.sys_db_object).toBe(1);
    expect(g.sys_dictionary).toBe(13);
    expect(g.sys_documentation).toBe(13);
    expect(g.sys_security_acl).toBe(4);
    expect(g.sys_security_acl_role).toBe(4);
    expect(g.sys_app_module).toBe(1);
    expect(g.total).toBe(36);
  });
  it("drops ACLs when createAccessControls is false", function () {
    var g = projectTableGraph(2, false, true);
    expect(g.sys_security_acl).toBe(0);
    expect(g.sys_security_acl_role).toBe(0);
  });
});

describe("applyTableSaveOverlay", function () {
  function overlay(): OverlaySpec {
    return {
      name: "x_cadso_core_error", label: "Error", tableSysId: "TBL", saveActionSysId: "SAVE",
      superClassSysId: "SUP", superClassLabel: "Application File", scopeSysId: "SCOPE",
      scopeLabel: "Tenon - Core", transactionScopeSysId: "SCOPE", numberPrefix: "ERR", userRoleSysId: "ROLE",
      userRoleLabel: "x_cadso_core.user", createAccessControls: true, access: "public",
      accessFlags: defaultAccessFlags(), selectedApplicationSysId: "APP", menuName: "Error",
      listEditKey: listEditKey("REL1"), columnXml: "<record_update/>"
    };
  }
  it("overlays the capability fields and preserves harvested defaults", function () {
    var base = { sysparm_ck: "CK", sysparm_encoded_record: "ENC", "69abc_text": "" };
    var f = applyTableSaveOverlay(base, overlay());
    expect(f["sysparm_ck"]).toBe("CK"); // preserved
    expect(f["sysparm_encoded_record"]).toBe("ENC"); // preserved
    expect(f["sys_db_object.name"]).toBe("x_cadso_core_error");
    expect(f["sys_db_object.super_class"]).toBe("SUP");
    expect(f["sys_db_object.sys_scope"]).toBe("SCOPE");
    expect(f["sys_db_object.number_ref.prefix"]).toBe("ERR");
    expect(f["sys_action"]).toBe("SAVE");
    expect(f["sys_uniqueValue"]).toBe("TBL");
    expect(f[listEditKey("REL1")]).toBe("<record_update/>");
    expect(f[showInMenuKey("new_menu_name")]).toBe("Error");
    expect(f["sys_db_object.create_access"]).toBe("true");
    expect(f["ni.sys_db_object.create_access"]).toBe("true");
  });
  it("stamps the transaction scope so the table lands in the target scope", function () {
    var f = applyTableSaveOverlay({}, overlay());
    expect(f["sysparm_transaction_scope"]).toBe("SCOPE");
    expect(f["sysparm_record_scope"]).toBe("SCOPE");
  });
  it("omits the transaction-scope fields when none is supplied", function () {
    var o = overlay();
    o.transactionScopeSysId = "";
    var f = applyTableSaveOverlay({}, o);
    expect(f["sysparm_transaction_scope"]).toBeUndefined();
    expect(f["sysparm_record_scope"]).toBeUndefined();
  });
  it("omits the nav module when no application sys_id is supplied", function () {
    var o = overlay();
    o.selectedApplicationSysId = "";
    var f = applyTableSaveOverlay({}, o);
    expect(f[showInMenuKey("show_in_menu")]).toBeUndefined();
  });
  it("does not mutate the base object", function () {
    var base: Record<string, string> = { sysparm_ck: "CK" };
    applyTableSaveOverlay(base, overlay());
    expect(Object.keys(base)).toEqual(["sysparm_ck"]);
  });
});

describe("parseSysIdFromLocation", function () {
  it("extracts the assigned sys_id from a 302 Location", function () {
    var loc = "sys_db_object.do?sys_id=1e539858c3ad4bd0d4ddf1db05013151&sysparm_view=";
    expect(parseSysIdFromLocation(loc)).toBe("1e539858c3ad4bd0d4ddf1db05013151");
  });
  it("returns empty string when no sys_id is present", function () {
    expect(parseSysIdFromLocation("sys_db_object_list.do")).toBe("");
    expect(parseSysIdFromLocation("")).toBe("");
  });
});

describe("parseFormInputs", function () {
  it("harvests name/value pairs and decodes HTML entities", function () {
    var html = '<input name="sysparm_ck" value="abc123"><input type="hidden" name="x" value="a &amp; b">';
    var f = parseFormInputs(html);
    expect(f["sysparm_ck"]).toBe("abc123");
    expect(f["x"]).toBe("a & b");
  });
});

describe("createTable dryRun", function () {
  it("returns a pure plan with the column XML and projected graph, no network", async function () {
    var result = await createTable({
      client: fakeClient(),
      name: "x_cadso_core_error", label: "Error", scope: "x_cadso_core",
      columns: [
        { label: "Key", type: "string", max_length: 255 },
        { label: "Severity", type: "choice", max_length: 50 }
      ],
      userRole: "x_cadso_core.user",
      dryRun: true
    });
    expect(result.status).toBe("dry-run");
    expect(result.tableSysId).toBe("");
    expect(result.columns).toBe(2);
    expect(result.resolvedColumns[0].type).toBe("string_full_utf8");
    expect(result.graph.total).toBe(1 + 3 + 3 + 4 + 4 + 1); // 1 obj +3 dict +3 doc +4 acl +4 role +1 module = 16
    expect(result.columnXml).toContain('<record_update table="sys_dictionary"');
  });
  it("validates the table identifier", async function () {
    await expect(createTable({
      client: fakeClient(), name: "Bad Name", label: "X", scope: "x_cadso_core",
      columns: [{ label: "A", type: "string" }], dryRun: true
    })).rejects.toThrow(/valid table identifier/);
  });
});

describe("create-table dictionary attributes (readonly_clickthrough default)", function () {
  it("DEFAULT: a reference column normalizes with readonly_clickthrough=true; other types get none", function () {
    var cols = normalizeColumns([
      { label: "Owner", type: "reference", reference: "sys_user" },
      { label: "Key", type: "string", max_length: 40 }
    ]);
    expect(cols[0].attributes).toBe("readonly_clickthrough=true");
    expect(cols[1].attributes).toBeUndefined();
  });
  it("OPT-OUT and MERGE per column", function () {
    var cols = normalizeColumns([
      { label: "A", type: "reference", reference: "sys_user", readonly_clickthrough: false },
      { label: "B", type: "reference", reference: "sys_user", attributes: "ref_auto_completer=X" },
      { label: "C", type: "string", attributes: { no_sort: true } }
    ]);
    expect(cols[0].attributes).toBeUndefined();
    expect(cols[1].attributes).toBe("ref_auto_completer=X,readonly_clickthrough=true");
    expect(cols[2].attributes).toBe("no_sort=true");
  });
  it("rejects a malformed attribute, naming the column", function () {
    expect(function () {
      normalizeColumns([{ label: "Owner", type: "reference", reference: "sys_user", attributes: "a=1,2" }]);
    }).toThrow(/createTable: column 'Owner' attributes: '2' is not a valid attribute name/);
  });
  it("renders the attribute into the Studio column XML as a modified field", function () {
    var xml = buildColumnXml(
      [{ label: "Owner", type: "reference", maxLength: "", reference: "sys_user", attributes: "readonly_clickthrough=true" }],
      ["z"]
    );
    expect(xml).toContain(
      '<field name="attributes" modified="true" value_set="true" dsp_set="false"><value>readonly_clickthrough=true</value></field>'
    );
  });
  it("leaves a column with no attributes byte-identical to Studio's payload", function () {
    var xml = buildColumnXml([{ label: "Key", type: "string_full_utf8", maxLength: "40", reference: "" }], ["z"]);
    expect(xml).toContain('<field name="attributes" modified="false" value_set="false" dsp_set="false"><value></value></field>');
  });
  it("dry-run reports each column's planned attributes", async function () {
    var result = await createTable({
      client: fakeClient(),
      name: "x_cadso_core_thing", label: "Thing", scope: "x_cadso_core",
      columns: [{ label: "Owner", type: "reference", reference: "sys_user" }],
      dryRun: true
    });
    expect(result.resolvedColumns[0].attributes).toBe("readonly_clickthrough=true");
    expect(result.columnXml).toContain("<value>readonly_clickthrough=true</value>");
  });
});

describe("verifyColumnAttributes (post-save read-back)", function () {
  function readBackClient(stored: Record<string, string>, opts?: { ignoreWrites?: boolean }) {
    var pushes: Array<Record<string, unknown>> = [];
    var c = fakeClient() as unknown as {
      table: { query: (t: string, q: string) => Promise<Array<Record<string, string>>> };
      claude: { pushWithUpdateSet: (p: Record<string, unknown>) => Promise<{ sys_id: string }> };
    };
    c.table.query = async function (table: string, query: string) {
      if (table !== "sys_dictionary") return [];
      if (query.indexOf("sys_id=") === 0) {
        return [{ sys_id: "OWNSYS", attributes: stored.Owner || "" }];
      }
      return Object.keys(stored).map(function (label) {
        return { sys_id: label.toUpperCase() + "SYS", element: label.toLowerCase(), column_label: label, attributes: stored[label] };
      });
    };
    c.claude.pushWithUpdateSet = async function (p: Record<string, unknown>) {
      pushes.push(p);
      var fields = p.fields as Record<string, string>;
      if (!(opts && opts.ignoreWrites)) stored.Owner = fields.attributes;
      return { sys_id: "OWNSYS" };
    };
    return { client: c as unknown as ServiceNowClient, pushes: pushes };
  }
  var cols: Array<NormalizedColumn> = [
    { label: "Owner", type: "reference", maxLength: "", reference: "sys_user", attributes: "readonly_clickthrough=true" },
    { label: "Key", type: "string_full_utf8", maxLength: "40", reference: "" }
  ];

  it("verifies without writing when the form save carried the attribute", async function () {
    var t = readBackClient({ Owner: "readonly_clickthrough=true", Key: "" });
    var checks = await verifyColumnAttributes(t.client, "x_t", cols, "us1");
    expect(checks).toHaveLength(1);
    expect(checks[0].verified).toBe(true);
    expect(checks[0].patched).toBe(false);
    expect(t.pushes).toHaveLength(0);
  });
  it("merge-patches ONCE into the update set when the form save dropped it", async function () {
    var t = readBackClient({ Owner: "ref_contributions=x", Key: "" });
    var checks = await verifyColumnAttributes(t.client, "x_t", cols, "us1");
    expect(checks[0].verified).toBe(true);
    expect(checks[0].patched).toBe(true);
    expect(t.pushes).toEqual([
      { update_set_sys_id: "us1", table: "sys_dictionary", record_sys_id: "OWNERSYS", fields: { attributes: "ref_contributions=x,readonly_clickthrough=true" } }
    ]);
  });
  it("fails the column when the patch does not stick", async function () {
    var t = readBackClient({ Owner: "", Key: "" }, { ignoreWrites: true });
    var checks = await verifyColumnAttributes(t.client, "x_t", cols, "us1");
    expect(checks[0].verified).toBe(false);
    expect(checks[0].note).toMatch(/still missing readonly_clickthrough=true/);
  });
  it("refuses to write an uncaptured patch when no update set was given", async function () {
    var t = readBackClient({ Owner: "", Key: "" });
    var checks = await verifyColumnAttributes(t.client, "x_t", cols, "");
    expect(checks[0].verified).toBe(false);
    expect(t.pushes).toHaveLength(0);
    expect(checks[0].note).toMatch(/no update set was given/);
  });
  it("reports a column it cannot find by label instead of throwing", async function () {
    var t = readBackClient({ Key: "" });
    var checks = await verifyColumnAttributes(t.client, "x_t", cols, "us1");
    expect(checks[0].verified).toBe(false);
    expect(checks[0].note).toMatch(/no sys_dictionary row labelled 'Owner'/);
  });
});
