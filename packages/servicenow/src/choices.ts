/**
 * addChoicesToField — upsert sys_choice rows for a given table.column,
 * and (optionally) flip sys_dictionary.choice so the column renders as a dropdown.
 *
 * All writes go through the Sincronia "Claude" Scripted REST API, which pins
 * each write to the supplied update set regardless of the REST user's current
 * preference. sys_scope on sys_choice is inherited from the dictionary record
 * so choices stay in the same application as the field.
 */

import type { ServiceNowClient } from "./client";
import type {
  AddChoicesParams,
  AddChoicesResult,
  ChoiceActionResult,
  ChoiceType,
  ChoiceValue,
  DictionaryRecord,
  UpdateSetRecord
} from "./types";

function encodeQueryValue(v: string): string {
  // ServiceNow encoded-query values: commas/carets/equals are special. We
  // don't expect them in table/column/value/language inputs, but keep this
  // escape-lite to surface surprises loudly rather than silently.
  if (/[,\^=]/.test(v)) {
    throw new Error("Invalid character in query value: " + JSON.stringify(v));
  }
  return v;
}

/**
 * Resolve a sys_scope record's namespace name (e.g. "x_cadso_core") from its
 * sys_id. The Claude REST API's `scope` parameter expects the namespace name,
 * not the sys_id, so dictionary records (whose sys_scope is a sys_id) need
 * a translation step before we can pass them through.
 */
async function resolveScopeName(
  client: ServiceNowClient,
  scopeSysId: string
): Promise<string> {
  if (!scopeSysId) return "";
  var rows = await client.table.query<{ scope: string; name: string }>(
    "sys_scope",
    "sys_id=" + encodeQueryValue(scopeSysId),
    1
  );
  if (rows.length === 0) {
    throw new Error("sys_scope record not found for sys_id " + scopeSysId);
  }
  // sys_scope.scope is the namespace (e.g. "x_cadso_core"); fall back to name
  // if a scope record was created without a populated scope field.
  return rows[0].scope || rows[0].name || "";
}

async function fetchDictionary(
  client: ServiceNowClient,
  table: string,
  column: string
): Promise<DictionaryRecord> {
  var rows = await client.table.query<DictionaryRecord>(
    "sys_dictionary",
    "name=" + encodeQueryValue(table) + "^element=" + encodeQueryValue(column),
    1
  );
  if (rows.length === 0) {
    throw new Error(
      "sys_dictionary record not found for " + table + "." + column +
      " — verify the field exists and your user has read access."
    );
  }
  var row = rows[0];
  // sys_scope comes back as a reference object or string depending on display_value.
  // We set sysparm_display_value=false in client.query so we get the sys_id string.
  var scope = typeof (row as any).sys_scope === "object" && row.sys_scope != null
    ? (row.sys_scope as any).value
    : row.sys_scope;
  return {
    sys_id: row.sys_id,
    name: row.name,
    element: row.element,
    choice: String(row.choice || "0"),
    sys_scope: scope || ""
  };
}

async function fetchUpdateSet(
  client: ServiceNowClient,
  sysId: string
): Promise<UpdateSetRecord> {
  var rows = await client.table.query<UpdateSetRecord>(
    "sys_update_set",
    "sys_id=" + encodeQueryValue(sysId),
    1
  );
  if (rows.length === 0) {
    throw new Error(
      "Update set " + sysId + " not found — verify the sys_id and your access."
    );
  }
  var row = rows[0];
  if (row.state && row.state !== "in progress" && row.state !== "in_progress") {
    throw new Error(
      "Update set " + row.name + " is in state '" + row.state +
      "' — only 'in progress' update sets can capture new changes."
    );
  }
  return row;
}

interface ExistingChoice {
  sys_id: string;
  value: string;
  label: string;
  sequence: string;
  language: string;
  inactive: string;
}

async function fetchExistingChoices(
  client: ServiceNowClient,
  table: string,
  column: string
): Promise<Array<ExistingChoice>> {
  return client.table.query<ExistingChoice>(
    "sys_choice",
    "name=" + encodeQueryValue(table) +
      "^element=" + encodeQueryValue(column),
    1000
  );
}

function buildChoiceFields(
  table: string,
  column: string,
  choice: ChoiceValue,
  scope: string
): Record<string, any> {
  var fields: Record<string, any> = {
    name: table,
    element: column,
    value: choice.value,
    label: choice.label,
    language: choice.language || "en",
    inactive: "false"
  };
  if (choice.sequence != null) {
    fields.sequence = String(choice.sequence);
  }
  if (scope) {
    fields.sys_scope = scope;
  }
  return fields;
}

function isUnchanged(existing: ExistingChoice, choice: ChoiceValue): boolean {
  var sameLabel = existing.label === choice.label;
  var sameLang = (existing.language || "en") === (choice.language || "en");
  var sameSeq = choice.sequence == null
    ? true
    : String(existing.sequence || "") === String(choice.sequence);
  return sameLabel && sameLang && sameSeq && existing.inactive === "false";
}

/**
 * Upsert choices for a field and (optionally) toggle sys_dictionary.choice.
 * Idempotent: re-running with the same inputs returns `action: "unchanged"`
 * for every row and skips the dictionary write when no change is required.
 */
export async function addChoicesToField(
  client: ServiceNowClient,
  params: AddChoicesParams
): Promise<AddChoicesResult> {
  if (!params.updateSetSysId) {
    throw new Error("updateSetSysId is required — every write must be captured in a named update set.");
  }
  if (!params.choices || params.choices.length === 0) {
    throw new Error("choices must be a non-empty array.");
  }

  var dict = await fetchDictionary(client, params.table, params.column);
  var updateSet = await fetchUpdateSet(client, params.updateSetSysId);
  var scopeName = await resolveScopeName(client, dict.sys_scope);
  var targetChoiceType: ChoiceType = params.choiceType === null
    ? (Number(dict.choice) as ChoiceType)
    : (params.choiceType != null ? params.choiceType : 3);

  var choiceWas = Number(dict.choice) as ChoiceType;
  var choiceNow = choiceWas;
  if (params.choiceType !== null && Number(dict.choice) !== targetChoiceType) {
    await client.claude.pushWithUpdateSet({
      update_set_sys_id: params.updateSetSysId,
      table: "sys_dictionary",
      record_sys_id: dict.sys_id,
      fields: { choice: String(targetChoiceType) }
    });
    choiceNow = targetChoiceType;
  }

  var existing = await fetchExistingChoices(client, params.table, params.column);
  var existingByValue: Record<string, ExistingChoice> = {};
  existing.forEach(function (row) {
    var key = (row.language || "en") + "::" + row.value;
    existingByValue[key] = row;
  });

  var results: Array<ChoiceActionResult> = [];
  for (var i = 0; i < params.choices.length; i += 1) {
    var choice = params.choices[i];
    var key = (choice.language || "en") + "::" + choice.value;
    var match = existingByValue[key];
    if (match && isUnchanged(match, choice)) {
      results.push({ value: choice.value, label: choice.label, sysId: match.sys_id, action: "unchanged" });
      continue;
    }
    if (match) {
      var updFields: Record<string, any> = {
        label: choice.label,
        language: choice.language || "en",
        inactive: "false"
      };
      if (choice.sequence != null) {
        updFields.sequence = String(choice.sequence);
      }
      await client.claude.pushWithUpdateSet({
        update_set_sys_id: params.updateSetSysId,
        table: "sys_choice",
        record_sys_id: match.sys_id,
        fields: updFields
      });
      results.push({ value: choice.value, label: choice.label, sysId: match.sys_id, action: "updated" });
      continue;
    }
    var created = await client.claude.createRecord({
      table: "sys_choice",
      fields: buildChoiceFields(params.table, params.column, choice, dict.sys_scope),
      scope: scopeName,
      update_set_sys_id: params.updateSetSysId
    });
    results.push({
      value: choice.value,
      label: choice.label,
      sysId: created.sys_id,
      action: "created"
    });
  }

  return {
    dictionary: {
      sysId: dict.sys_id,
      scope: dict.sys_scope,
      choiceWas: choiceWas,
      choiceNow: choiceNow
    },
    updateSet: { sysId: updateSet.sys_id, name: updateSet.name },
    choices: results
  };
}
