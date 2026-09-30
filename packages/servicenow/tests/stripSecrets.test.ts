/**
 * strip-secrets unit tests.
 *
 * fixtures/stripSecrets.unload.xml is a SYNTHETIC unload shaped exactly like a
 * real one (entity-encoded record payloads inside <payload>), carrying fixture
 * values only — no real credential ever enters this repo. The record shapes
 * mirror what tenonworkstudio actually captures: password2 properties, a
 * string-typed API-key property, oauth_entity.client_secret, an empty
 * basic_auth_password, a JSON-blob setting, and a plain script include.
 */

import * as fs from "fs";
import * as path from "path";
import {
  stripSecrets,
  verifyStripped,
  readField,
  readRecordTable,
  stripField,
  plannedStrips,
  stripJsonValue,
  recordFieldNames,
  encodeXmlEntities,
} from "../src/secrets/stripSecrets";
import {
  defaultSecretRules,
  mergeSecretRules,
  secretFieldsFromDictionary,
  isCapturable,
  SENTINEL,
} from "../src/secrets/secretRules";
import type { SecretRules } from "../src/secrets/secretRules";

var FIXTURES = path.join(__dirname, "fixtures");
function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

/** Every fixture value that must never survive a strip. */
var FIXTURE_SECRETS = [
  "FIXTURE-PASSWORD2-CIPHERTEXT",
  "FIXTURE-PLAINTEXT-APIKEY",
  "FIXTURE-CLIENT-SECRET",
  "FIXTURE-BLOB-SECRET",
];

function rules(): SecretRules {
  return defaultSecretRules();
}

describe("readField / readRecordTable / recordFieldNames", function () {
  var record =
    '<record_update table="sys_properties"><sys_properties action="INSERT_OR_UPDATE">' +
    "<name>x.y</name><type>password2</type><value>abc</value><empty/></sys_properties></record_update>";

  it("reads the record table from the table attribute", function () {
    expect(readRecordTable(record)).toBe("sys_properties");
  });

  it("falls back to the first element when the attribute is absent", function () {
    var noAttr =
      '<record_update><oauth_entity action="INSERT_OR_UPDATE"><name>x</name></oauth_entity></record_update>';
    expect(readRecordTable(noAttr)).toBe("oauth_entity");
  });

  it("reads a field body and decodes entities", function () {
    expect(readField(record, "type")).toBe("password2");
    expect(readField("<a>&lt;b&gt;</a>", "a")).toBe("<b>");
  });

  it("returns null for an absent field and empty string for a self-closing one", function () {
    expect(readField(record, "nope")).toBeNull();
    expect(readField(record, "empty")).toBe("");
  });

  it("lists the record's field names", function () {
    var names = recordFieldNames(record);
    expect(names).toContain("name");
    expect(names).toContain("value");
    expect(names).toContain("empty");
  });
});

describe("plannedStrips", function () {
  it("plans an L1 type field", function () {
    var record =
      '<record_update table="oauth_entity"><oauth_entity><client_secret>x</client_secret></oauth_entity></record_update>';
    var planned = plannedStrips(record, "oauth_entity", rules());
    expect(planned).toEqual([
      { field: "client_secret", reason: "L1:password-type" },
    ]);
  });

  it("plans sys_properties.value only when the property type is a password type", function () {
    var secret =
      '<record_update table="sys_properties"><sys_properties><type>password2</type><value>x</value></sys_properties></record_update>';
    var plain =
      '<record_update table="sys_properties"><sys_properties><name>x_cadso_core.some_flag</name><type>string</type><value>true</value></sys_properties></record_update>';
    expect(plannedStrips(secret, "sys_properties", rules())[0].reason).toBe(
      "L2:sys_properties-password-type",
    );
    expect(plannedStrips(plain, "sys_properties", rules())).toEqual([]);
  });

  it("plans the explicitly listed string-typed API key property", function () {
    var record =
      '<record_update table="sys_properties"><sys_properties><name>x_cadso_core.google_translate_api_key</name><type>string</type><value>x</value></sys_properties></record_update>';
    expect(plannedStrips(record, "sys_properties", rules())[0].reason).toBe(
      "L2:google-translate-api-key",
    );
  });

  it("skips a field a reviewer has declared not secret", function () {
    var merged = mergeSecretRules(rules(), {
      notSecret: [
        {
          table: "oauth_entity",
          field: "client_secret",
          reason: "fixture exemption for the test",
        },
      ],
    });
    var record =
      '<record_update table="oauth_entity"><oauth_entity><client_secret>x</client_secret></oauth_entity></record_update>';
    expect(plannedStrips(record, "oauth_entity", merged)).toEqual([]);
  });
});

describe("stripField", function () {
  it("replaces a populated field body", function () {
    var res = stripField("<a><b>secret</b></a>", "b", SENTINEL);
    expect(res.stripped).toBe(true);
    expect(res.xml).toBe("<a><b>" + SENTINEL + "</b></a>");
  });

  it("normalises a self-closing field to the sentinel", function () {
    var res = stripField("<a><b/></a>", "b", SENTINEL);
    expect(res.stripped).toBe(true);
    expect(res.xml).toBe("<a><b>" + SENTINEL + "</b></a>");
  });

  it("reports when the field is absent", function () {
    expect(stripField("<a><c>x</c></a>", "b", SENTINEL).stripped).toBe(false);
  });

  it("keeps attributes on the element it rewrites", function () {
    var res = stripField(
      '<a><b display_value="X">secret</b></a>',
      "b",
      SENTINEL,
    );
    expect(res.xml).toBe('<a><b display_value="X">' + SENTINEL + "</b></a>");
  });
});

describe("stripJsonValue", function () {
  it("replaces secret keys at any depth and records the paths", function () {
    var hits: Array<string> = [];
    var out = stripJsonValue(
      { a: { client_secret: "x" }, list: [{ token: "y" }], keep: "z" },
      ["client_secret", "token"],
      SENTINEL,
      "",
      hits,
    );
    expect(out).toEqual({
      a: { client_secret: SENTINEL },
      list: [{ token: SENTINEL }],
      keep: "z",
    });
    expect(hits).toEqual(["a.client_secret", "list[0].token"]);
  });

  it("matches keys case-insensitively", function () {
    var hits: Array<string> = [];
    var out = stripJsonValue(
      { Client_Secret: "x" },
      ["client_secret"],
      SENTINEL,
      "",
      hits,
    );
    expect(out).toEqual({ Client_Secret: SENTINEL });
  });
});

describe("stripSecrets — the whole document", function () {
  it("removes every fixture secret and leaves no real value behind", function () {
    var result = stripSecrets(fixture("stripSecrets.unload.xml"), rules());
    for (var i = 0; i < FIXTURE_SECRETS.length; i += 1) {
      expect(result.xml).not.toContain(FIXTURE_SECRETS[i]);
    }
    expect(JSON.stringify(result.secretFields)).not.toContain("FIXTURE-");
  });

  it("strips each expected field with the rule that decided it", function () {
    var result = stripSecrets(fixture("stripSecrets.unload.xml"), rules());
    var byField: Record<string, string> = {};
    for (var i = 0; i < result.secretFields.length; i += 1) {
      byField[
        result.secretFields[i].table + "." + result.secretFields[i].field
      ] = result.secretFields[i].reason;
    }
    expect(byField["sys_properties.value"]).toBeDefined();
    expect(byField["oauth_entity.client_secret"]).toBe("L1:password-type");
    expect(byField["sys_rest_message.basic_auth_password"]).toBe(
      "L1:password-type",
    );
    expect(byField["x_cadso_core_setting.value"]).toBe("L3:json-key");
  });

  it("strips a secret nested in a JSON blob without destroying the blob", function () {
    var result = stripSecrets(fixture("stripSecrets.unload.xml"), rules());
    expect(result.xml).toContain(
      encodeXmlEntities('"client_secret":"' + SENTINEL + '"'),
    );
    expect(result.xml).toContain(
      encodeXmlEntities('"endpoint":"https://example.invalid/api"'),
    );
  });

  it("sentinel-normalises a secret field that had no value", function () {
    var result = stripSecrets(fixture("stripSecrets.unload.xml"), rules());
    expect(result.xml).toContain(
      "&lt;basic_auth_password&gt;" + SENTINEL + "&lt;/basic_auth_password&gt;",
    );
  });

  it("preserves structure, keys and non-secret fields", function () {
    var result = stripSecrets(fixture("stripSecrets.unload.xml"), rules());
    expect(result.recordsScanned).toBe(6);
    expect(result.xml).toContain(
      "&lt;client_id&gt;fixture-client-id&lt;/client_id&gt;",
    );
    expect(result.xml).toContain(
      "&lt;basic_auth_user&gt;svc.tenon&lt;/basic_auth_user&gt;",
    );
    expect(result.xml).toContain(
      "&lt;sys_id&gt;cccccccccccccccccccccccccccccccc&lt;/sys_id&gt;",
    );
    expect(result.xml).toContain("var x = 1; // nothing secret here");
    expect(result.xml).toContain(
      '<sys_remote_update_set action="INSERT_OR_UPDATE">',
    );
  });

  it("passes its own verification", function () {
    var result = stripSecrets(fixture("stripSecrets.unload.xml"), rules());
    expect(verifyStripped(result.xml, rules())).toEqual([]);
  });
});

describe("stripSecrets — fail-closed behaviour", function () {
  var suspicious =
    "<unload><sys_update_xml><payload>" +
    encodeXmlEntities(
      '<record_update table="x_cadso_core_thing"><x_cadso_core_thing action="INSERT_OR_UPDATE">' +
        "<sys_id>11111111111111111111111111111111</sys_id>" +
        "<webhook_token>looks-secret</webhook_token></x_cadso_core_thing></record_update>",
    ) +
    "</payload></sys_update_xml></unload>";

  it("throws when a field looks secret but no rule covers it", function () {
    expect(function () {
      stripSecrets(suspicious, rules());
    }).toThrow(/look secret but are not covered by a rule/);
  });

  it("names the offending field and says nothing was written", function () {
    expect(function () {
      stripSecrets(suspicious, rules());
    }).toThrow(/x_cadso_core_thing\.webhook_token[\s\S]*Nothing was written/);
  });

  it("reports instead of throwing when the caller asks for a review list", function () {
    var result = stripSecrets(suspicious, rules(), { allowUnreviewed: true });
    expect(result.reviewFindings.length).toBe(1);
    expect(result.reviewFindings[0].field).toBe("webhook_token");
    expect(JSON.stringify(result.reviewFindings)).not.toContain("looks-secret");
  });

  it("stops flagging once a reviewer records the field as not secret", function () {
    var merged = mergeSecretRules(rules(), {
      notSecret: [
        {
          table: "x_cadso_core_thing",
          field: "webhook_token",
          reason: "identifier for the webhook, not a credential",
        },
      ],
    });
    var result = stripSecrets(suspicious, merged);
    expect(result.reviewFindings).toEqual([]);
    expect(result.xml).toContain("looks-secret");
  });

  it("strips the field instead once a reviewer records it as secret", function () {
    var merged = mergeSecretRules(rules(), {
      fieldRules: [
        {
          id: "thing-webhook-token",
          table: "x_cadso_core_thing",
          field: "webhook_token",
          reason: "shared signing token for the inbound webhook",
        },
      ],
    });
    var result = stripSecrets(suspicious, merged);
    expect(result.xml).not.toContain("looks-secret");
    expect(result.secretFields[0].reason).toBe("L2:thing-webhook-token");
  });

  it("refuses a payload whose record table cannot be resolved", function () {
    var malformed =
      "<unload><sys_update_xml><payload>not xml at all</payload></sys_update_xml></unload>";
    expect(function () {
      stripSecrets(malformed, rules());
    }).toThrow(/no resolvable record table/);
  });

  it("refuses an empty document", function () {
    expect(function () {
      stripSecrets("", rules());
    }).toThrow(/nothing to strip/);
  });
});

describe("verifyStripped", function () {
  it("catches a secret that survived", function () {
    var leaked = fixture("stripSecrets.unload.xml");
    var problems = verifyStripped(leaked, rules());
    expect(problems).toContain("oauth_entity.client_secret");
    expect(problems).toContain("sys_properties.value");
  });
});

describe("secretFieldsFromDictionary", function () {
  var rows = [
    {
      name: "oauth_entity",
      element: "client_secret",
      internal_type: { value: "password2" },
    },
    {
      name: "discovery_credentials",
      element: "password",
      internal_type: { value: "password2" },
    },
    { name: "sys_user", element: "user_password", internal_type: "password" },
    {
      name: "oauth_entity",
      element: "name",
      internal_type: { value: "string" },
    },
    {
      name: "var__m_sys_hub_step_ext_output_x",
      element: "sn_auth_token",
      internal_type: { value: "password2" },
    },
  ];

  it("keeps password fields only on capturable tables", function () {
    var map = secretFieldsFromDictionary(rows, ["oauth_entity", "sys_user"]);
    expect(map.oauth_entity).toEqual(["client_secret"]);
    expect(map.sys_user).toEqual(["user_password"]);
    expect(map.discovery_credentials).toBeUndefined();
  });

  it("drops flow-variable definition tables", function () {
    var map = secretFieldsFromDictionary(rows, [
      "var__m_sys_hub_step_ext_output_x",
    ]);
    expect(Object.keys(map)).toEqual([]);
  });

  it("reads the capturable flag off the collection attributes", function () {
    expect(
      isCapturable({
        name: "sys_properties",
        attributes: "no_attachments=true,update_synch=true",
      }),
    ).toBe(true);
    expect(
      isCapturable({ name: "discovery_credentials", attributes: "" }),
    ).toBe(false);
    expect(isCapturable({ name: "x" })).toBe(false);
  });
});

describe("mergeSecretRules — validation", function () {
  it("requires a reason on an exemption", function () {
    expect(function () {
      mergeSecretRules(rules(), { notSecret: [{ table: "a", field: "b" }] });
    }).toThrow(/needs a reason/);
  });

  it("requires a reason on a custom strip rule", function () {
    expect(function () {
      mergeSecretRules(rules(), { fieldRules: [{ table: "a", field: "b" }] });
    }).toThrow(/reason is required/);
  });

  it("rejects a non-object override", function () {
    expect(function () {
      mergeSecretRules(rules(), "nope");
    }).toThrow(/must be a JSON object/);
  });

  it("adds table fields without dropping the baseline", function () {
    var merged = mergeSecretRules(rules(), {
      typeFields: { oauth_entity: ["extra_secret"] },
    });
    expect(merged.typeFields.oauth_entity).toEqual([
      "client_secret",
      "extra_secret",
    ]);
  });
});
