import {
  addColumn,
  deriveElement,
  applyAddColumnOverlay,
  listEditKey,
  parseFormInputs
} from "../src/table";
import type { ServiceNowClient } from "../src/client";

/** A client whose every call throws — proves dryRun + validation touch no network. */
function noNetworkClient(): ServiceNowClient {
  function boom(): never { throw new Error("network call not allowed"); }
  return {
    table: { query: async function () { return boom(); } },
    buildAgent: {
      runQuery: async function () { return boom(); },
      getTableSchema: async function () { return boom(); }
    },
    claude: {
      createRecord: async function () { return boom(); },
      pushWithUpdateSet: async function () { return boom(); },
      currentUpdateSet: async function () { return boom(); },
      changeUpdateSet: async function () { return boom(); },
      deleteRecord: async function () { return boom(); }
    },
    attachment: {
      listFor: async function () { return []; },
      upload: async function () { return { sys_id: "att", file_name: "", content_type: "" }; },
      remove: async function () { return undefined; }
    },
    now: {
      get: async function () { return boom(); },
      post: async function () { return boom(); },
      put: async function () { return boom(); },
      delete: async function () { return boom(); },
      invoke: async function () { return boom(); }
    }
  } as ServiceNowClient;
}

describe("deriveElement", function () {
  it("derives a scoped element from a label (no u_ prefix)", function () {
    expect(deriveElement("URL")).toBe("url");
    expect(deriveElement("First Seen On")).toBe("first_seen_on");
    expect(deriveElement("A & B!")).toBe("a_b");
  });
  it("prefers an explicit name over the derived label", function () {
    expect(deriveElement("Some Label", "my_field")).toBe("my_field");
  });
  it("throws when nothing usable can be derived", function () {
    expect(function () { deriveElement("!!!"); }).toThrow(/cannot derive a column name/);
  });
});

describe("applyAddColumnOverlay", function () {
  function opts() {
    return {
      tableSysId: "TBL",
      saveActionSysId: "SAVE",
      listEditKey: listEditKey("REL1"),
      columnXml: "<record_update/>"
    };
  }
  it("injects the column XML under the harvested list-edit key", function () {
    var f = applyAddColumnOverlay({ sysparm_ck: "CK" }, opts());
    expect(f[listEditKey("REL1")]).toBe("<record_update/>");
  });
  it("sets the save machinery against the EXISTING record sys_id", function () {
    var f = applyAddColumnOverlay({}, opts());
    expect(f["sys_target"]).toBe("sys_db_object");
    expect(f["sys_action"]).toBe("SAVE");
    expect(f["sys_uniqueValue"]).toBe("TBL");
    expect(f["sys_row"]).toBe("TBL");
  });
  it("preserves harvested table fields untouched (does not re-stamp the table)", function () {
    var base = {
      sysparm_ck: "CK",
      "sys_db_object.name": "x_cadso_journey",
      "sys_db_object.label": "Journey",
      "sys_db_object.sys_scope": "SCOPE"
    };
    var f = applyAddColumnOverlay(base, opts());
    expect(f["sys_db_object.name"]).toBe("x_cadso_journey");
    expect(f["sys_db_object.label"]).toBe("Journey");
    expect(f["sys_db_object.sys_scope"]).toBe("SCOPE");
    expect(f["sysparm_ck"]).toBe("CK");
  });
  it("does not mutate the base object", function () {
    var base: Record<string, string> = { sysparm_ck: "CK" };
    applyAddColumnOverlay(base, opts());
    expect(Object.keys(base)).toEqual(["sysparm_ck"]);
  });
  it("injects nothing when the list-edit key is empty", function () {
    var o = opts();
    o.listEditKey = "";
    var f = applyAddColumnOverlay({}, o);
    expect(f[""]).toBeUndefined();
    expect(JSON.stringify(f).indexOf("record_update")).toBe(-1);
  });
});

describe("parseFormInputs (existing-record list-edit key)", function () {
  it("harvests the ListEditFormatterAction key from an existing table form", function () {
    var key = "ni.java.com.glide.ui_list_edit.ListEditFormatterAction[sys_db_object.REL:4344f6f5bf1320001875647fcf0739ad]";
    var html =
      '<input name="sysparm_ck" value="abc123">' +
      '<input type="hidden" name="' + key + '" value="">' +
      '<input name="sys_db_object.name" value="x_cadso_journey">';
    var f = parseFormInputs(html);
    var keys = Object.keys(f);
    var found = keys.filter(function (k) {
      return k.indexOf("ListEditFormatterAction[sys_db_object.REL:") !== -1;
    });
    expect(found.length).toBe(1);
    expect(found[0]).toBe(key);
    expect(f["sys_db_object.name"]).toBe("x_cadso_journey");
  });
});

describe("addColumn dryRun", function () {
  it("returns a pure plan with the column XML and resolved type, no network", async function () {
    var result = await addColumn({
      client: noNetworkClient(),
      table: "x_cadso_journey",
      column: { label: "URL", type: "url", max_length: 1024 },
      updateSetSysId: "us1",
      dryRun: true
    });
    expect(result.status).toBe("dry-run");
    expect(result.element).toBe("url");
    expect(result.internalType).toBe("url");
    expect(result.tableSysId).toBe("");
    expect(result.verified).toBe(false);
    expect(result.updateSetSysId).toBe("us1");
    expect(result.columnXml).toContain('<record_update table="sys_dictionary"');
    expect(result.columnXml).toContain("<display_value>URL</display_value>");
  });
  it("honours an explicit column name on dry-run", async function () {
    var result = await addColumn({
      client: noNetworkClient(),
      table: "x_cadso_journey",
      column: { label: "Recipient URL", type: "url", name: "url" },
      dryRun: true
    });
    expect(result.element).toBe("url");
  });
});

describe("addColumn validation", function () {
  it("requires a table", async function () {
    await expect(addColumn({
      client: noNetworkClient(),
      table: "",
      column: { label: "URL", type: "url" },
      dryRun: true
    })).rejects.toThrow(/table is required/);
  });
  it("rejects an unknown column type via normalizeColumns", async function () {
    await expect(addColumn({
      client: noNetworkClient(),
      table: "x_cadso_journey",
      column: { label: "X", type: "frobnicate" },
      dryRun: true
    })).rejects.toThrow(/unknown column type/);
  });
  it("rejects a reference column with no target", async function () {
    await expect(addColumn({
      client: noNetworkClient(),
      table: "x_cadso_journey",
      column: { label: "Owner", type: "reference" },
      dryRun: true
    })).rejects.toThrow(/reference target/);
  });
});
