/**
 * addChoicesToField — upsert sys_choice rows for a given table.column,
 * and (optionally) flip sys_dictionary.choice so the column renders as a dropdown.
 *
 * All writes go through the Dovetail "Claude" Scripted REST API, which pins
 * each write to the supplied update set regardless of the REST user's current
 * preference. sys_scope on sys_choice is inherited from the dictionary record
 * so choices stay in the same application as the field.
 */

import type { ServiceNowClient } from "./client";
import type {
  AddChoicesParams,
  AddChoicesResult,
  ChoiceActionResult,
  ChoiceRemovalResult,
  ChoiceType,
  ChoiceValue,
  DictionaryRecord,
  RemoveChoicesParams,
  RemoveChoicesResult,
  UpdateSetRecord,
} from "./types";

export function encodeQueryValue(v: string): string {
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
  scopeSysId: string,
): Promise<string> {
  if (!scopeSysId) return "";
  var rows = await client.table.query<{ scope: string; name: string }>(
    "sys_scope",
    "sys_id=" + encodeQueryValue(scopeSysId),
    1,
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
  column: string,
): Promise<DictionaryRecord> {
  var rows = await client.table.query<DictionaryRecord>(
    "sys_dictionary",
    "name=" + encodeQueryValue(table) + "^element=" + encodeQueryValue(column),
    1,
  );
  if (rows.length === 0) {
    throw new Error(
      "sys_dictionary record not found for " +
        table +
        "." +
        column +
        " — verify the field exists and your user has read access.",
    );
  }
  var row = rows[0];
  // sys_scope comes back as a reference object or string depending on display_value.
  // We set sysparm_display_value=false in client.query so we get the sys_id string.
  var scope =
    typeof (row as any).sys_scope === "object" && row.sys_scope != null
      ? (row.sys_scope as any).value
      : row.sys_scope;
  return {
    sys_id: row.sys_id,
    name: row.name,
    element: row.element,
    choice: String(row.choice || "0"),
    sys_scope: scope || "",
  };
}

async function fetchUpdateSet(
  client: ServiceNowClient,
  sysId: string,
): Promise<UpdateSetRecord> {
  var rows = await client.table.query<UpdateSetRecord>(
    "sys_update_set",
    "sys_id=" + encodeQueryValue(sysId),
    1,
  );
  if (rows.length === 0) {
    throw new Error(
      "Update set " + sysId + " not found — verify the sys_id and your access.",
    );
  }
  var row = rows[0];
  if (row.state && row.state !== "in progress" && row.state !== "in_progress") {
    throw new Error(
      "Update set " +
        row.name +
        " is in state '" +
        row.state +
        "' — only 'in progress' update sets can capture new changes.",
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

var CHOICE_PAGE_LIMIT = 1000;

/**
 * Values per encoded-query batch. Keeps `valueIN a,b,c…` comfortably inside practical
 * URL limits when a caller passes a long list.
 */
var CHOICE_QUERY_BATCH = 50;

/**
 * Read the existing sys_choice rows for JUST the values being acted on.
 *
 * Scoped rather than whole-field on purpose. Reading every row of the field means the
 * result set grows with the field, not with the request, and `client.table.query` has no
 * `sysparm_offset` — so a field with more choices than one page could only be handled by
 * guessing at a truncated read (silently wrong: the add path inserts a duplicate, the
 * remove path reports a live value as "missing") or by refusing outright, which would
 * make both verbs unusable on large choice sets. Asking only for the requested values
 * bounds the read by the request, so large fields stay editable and there is nothing to
 * truncate.
 *
 * Note that values are interpolated into an encoded query, so `encodeQueryValue` rejects
 * ones carrying `,` `^` `=`. Both CLI surfaces already split on those characters, so such
 * values were never expressible there; the library paths now refuse them loudly rather
 * than building a malformed query.
 */
async function fetchExistingChoices(
  client: ServiceNowClient,
  table: string,
  column: string,
  values: Array<string>,
): Promise<Array<ExistingChoice>> {
  var base =
    "name=" + encodeQueryValue(table) + "^element=" + encodeQueryValue(column);
  var out: Array<ExistingChoice> = [];
  for (var i = 0; i < values.length; i += CHOICE_QUERY_BATCH) {
    var batch = values.slice(i, i + CHOICE_QUERY_BATCH).map(encodeQueryValue);
    // Ask for one MORE than the ceiling: requesting exactly it cannot distinguish "there
    // are exactly that many" from "there are more and this is page 1".
    var rows = await client.table.query<ExistingChoice>(
      "sys_choice",
      base + "^valueIN" + batch.join(","),
      CHOICE_PAGE_LIMIT + 1,
    );
    // A backstop, not an everyday path: this batch asked for at most CHOICE_QUERY_BATCH
    // values, so overflowing a page means one value has an absurd number of duplicate
    // rows. Refuse rather than act on a read that may be incomplete.
    if (rows.length > CHOICE_PAGE_LIMIT) {
      throw new Error(
        "Refusing to act on a truncated choice list: " +
          table +
          "." +
          column +
          " returned more than " +
          CHOICE_PAGE_LIMIT +
          " sys_choice rows for a single batch of requested values, so the read cannot " +
          "be trusted to be complete.",
      );
    }
    out = out.concat(rows);
  }
  return out;
}

/**
 * Group the instance's rows by language::value, keeping EVERY row per key.
 *
 * sys_choice has no uniqueness constraint on (name, element, value, language), so a
 * field can genuinely hold two live rows for one value. Indexing to a single row would
 * act on one and silently leave the other — the tool reports success while the choice
 * still renders in the dropdown.
 */
function groupExistingByKey(
  rows: Array<ExistingChoice>,
): Record<string, Array<ExistingChoice>> {
  // Null-prototype: keys derive from record data, and Object.prototype members must not
  // masquerade as existing entries. See dedupe() for the failure this avoids.
  var byKey: Record<string, Array<ExistingChoice>> = Object.create(null);
  rows.forEach(function (row) {
    var key = (row.language || "en") + "::" + row.value;
    if (!byKey[key]) byKey[key] = [];
    byKey[key].push(row);
  });
  return byKey;
}

/**
 * Collapse choices that target the same language::value. Position is first-seen, but
 * the LAST spec wins, so `[{a,"Old"},{a,"New"}]` upserts the label the caller asked for
 * most recently rather than silently writing both.
 */
function dedupeChoices(choices: Array<ChoiceValue>): Array<ChoiceValue> {
  var byKey: Record<string, ChoiceValue> = Object.create(null);
  var order: Array<string> = [];
  choices.forEach(function (c) {
    var key = (c.language || "en") + "::" + c.value;
    if (!byKey[key]) order.push(key);
    byKey[key] = c;
  });
  return order.map(function (key) {
    return byKey[key];
  });
}

/**
 * Preserve first-seen order while dropping repeats.
 *
 * The lookup is a null-prototype map because the keys are raw choice values: on a plain
 * `{}`, `seen["constructor"]` / `["toString"]` / `["__proto__"]` are already truthy via
 * Object.prototype, so a value with one of those names would be treated as a repeat and
 * silently dropped from the request — never written, never even reported.
 */
function dedupe(values: Array<string>): Array<string> {
  var seen: Record<string, boolean> = Object.create(null);
  var out: Array<string> = [];
  values.forEach(function (v) {
    if (seen[v]) return;
    seen[v] = true;
    out.push(v);
  });
  return out;
}

function buildChoiceFields(
  table: string,
  column: string,
  choice: ChoiceValue,
  scope: string,
): Record<string, any> {
  var fields: Record<string, any> = {
    name: table,
    element: column,
    value: choice.value,
    label: choice.label,
    language: choice.language || "en",
    inactive: "false",
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
  var sameSeq =
    choice.sequence == null
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
  params: AddChoicesParams,
): Promise<AddChoicesResult> {
  if (!params.updateSetSysId) {
    throw new Error(
      "updateSetSysId is required — every write must be captured in a named update set.",
    );
  }
  if (!params.choices || params.choices.length === 0) {
    throw new Error("choices must be a non-empty array.");
  }

  var dict = await fetchDictionary(client, params.table, params.column);
  var updateSet = await fetchUpdateSet(client, params.updateSetSysId);
  var scopeName = await resolveScopeName(client, dict.sys_scope);
  var targetChoiceType: ChoiceType =
    params.choiceType === null
      ? (Number(dict.choice) as ChoiceType)
      : params.choiceType != null
      ? params.choiceType
      : 3;

  var choiceWas = Number(dict.choice) as ChoiceType;
  var choiceNow = choiceWas;
  if (params.choiceType !== null && Number(dict.choice) !== targetChoiceType) {
    await client.claude.pushWithUpdateSet({
      update_set_sys_id: params.updateSetSysId,
      table: "sys_dictionary",
      record_sys_id: dict.sys_id,
      fields: { choice: String(targetChoiceType) },
    });
    choiceNow = targetChoiceType;
  }

  // Collapse repeats on language::value, last spec wins. Without this a value listed
  // twice is created twice — the cache is read once up front, so the second pass still
  // sees "not present" and inserts a genuine duplicate sys_choice row.
  var choices = dedupeChoices(params.choices);

  // Read only the values being upserted — see fetchExistingChoices on why the read is
  // scoped to the request rather than the whole field.
  var existing = await fetchExistingChoices(
    client,
    params.table,
    params.column,
    dedupe(
      choices.map(function (c) {
        return c.value;
      }),
    ),
  );
  var existingByValue = groupExistingByKey(existing);

  var results: Array<ChoiceActionResult> = [];
  for (var i = 0; i < choices.length; i += 1) {
    var choice = choices[i];
    var key = (choice.language || "en") + "::" + choice.value;
    var matches = existingByValue[key] || [];
    var matchSysIds = matches.map(function (row) {
      return row.sys_id;
    });
    // Every live row for this value, not just one: a field can already hold duplicates,
    // and updating one would leave the other showing the old label in the dropdown.
    var stale = matches.filter(function (row) {
      return !isUnchanged(row, choice);
    });
    if (matches.length > 0 && stale.length === 0) {
      results.push({
        value: choice.value,
        label: choice.label,
        sysId: matchSysIds[0],
        sysIds: matchSysIds,
        action: "unchanged",
      });
      continue;
    }
    if (matches.length > 0) {
      var updFields: Record<string, any> = {
        label: choice.label,
        language: choice.language || "en",
        inactive: "false",
      };
      if (choice.sequence != null) {
        updFields.sequence = String(choice.sequence);
      }
      for (var s = 0; s < stale.length; s += 1) {
        await client.claude.pushWithUpdateSet({
          update_set_sys_id: params.updateSetSysId,
          table: "sys_choice",
          record_sys_id: stale[s].sys_id,
          fields: updFields,
        });
      }
      results.push({
        value: choice.value,
        label: choice.label,
        sysId: matchSysIds[0],
        sysIds: matchSysIds,
        action: "updated",
      });
      continue;
    }
    var created = await client.claude.createRecord({
      table: "sys_choice",
      fields: buildChoiceFields(
        params.table,
        params.column,
        choice,
        dict.sys_scope,
      ),
      scope: scopeName,
      update_set_sys_id: params.updateSetSysId,
    });
    results.push({
      value: choice.value,
      label: choice.label,
      sysId: created.sys_id,
      sysIds: [created.sys_id],
      action: "created",
    });
  }

  return {
    dictionary: {
      sysId: dict.sys_id,
      scope: dict.sys_scope,
      choiceWas: choiceWas,
      choiceNow: choiceNow,
    },
    updateSet: { sysId: updateSet.sys_id, name: updateSet.name },
    choices: results,
  };
}

/**
 * Soft-delete choice values for a field: set `inactive=true` on each matching
 * sys_choice row via pushWithUpdateSet. NEVER a hard delete — the row stays, so the
 * change is reversible and the historical value still resolves on records that
 * already hold it. (A hard drop of sys_choice is deliberately deferred; see DEV-511.)
 *
 * Idempotent:
 *   - active value     -> "deactivated" (every live row for it flipped to inactive —
 *                         usually one write, but more when the field holds duplicates)
 *   - already inactive -> "unchanged"  (no write)
 *   - value not found  -> "missing"    (no write)
 *
 * The dictionary row is fetched only to PROVE the field exists — without that guard a
 * mistyped column reports every value as "missing", the silent-failure this family
 * exists to catch. sys_dictionary.choice is left alone on purpose: removing values
 * does not un-make the column a choice field.
 *
 * Repeated values are collapsed before the loop, so `["a", "a"]` is one write and one
 * result row — an idempotent verb must not depend on the caller de-duplicating first.
 *
 * LIMITATION — inherited choices. Matching is scoped to `sys_choice.name = <table>`, so
 * a value defined on a PARENT table (task.state inherited by a child) reports "missing"
 * rather than being deactivated. Hiding an inherited choice on a child table needs an
 * override row on the child, which this verb does not write. For the x_cadso_* tables
 * this family targets that case does not arise; on extended OOB tables, treat a
 * surprising "missing" as a signal to check the parent.
 */
export async function removeChoicesFromField(
  client: ServiceNowClient,
  params: RemoveChoicesParams,
): Promise<RemoveChoicesResult> {
  if (!params.updateSetSysId) {
    throw new Error(
      "updateSetSysId is required — every write must be captured in a named update set.",
    );
  }
  if (!params.values || params.values.length === 0) {
    throw new Error("values must be a non-empty array.");
  }
  var language = params.language || "en";

  // fetchDictionary throws a clear error when the field does not exist; fetchUpdateSet
  // throws unless the set is in progress. Both mirror the add path's guards.
  var dict = await fetchDictionary(client, params.table, params.column);
  var updateSet = await fetchUpdateSet(client, params.updateSetSysId);

  // Collapse repeats: without this a duplicated value writes twice and is counted
  // twice in the summary, which contradicts the idempotency contract.
  var values = dedupe(params.values);

  // Read only the values being removed — see fetchExistingChoices on why the read is
  // scoped to the request rather than the whole field.
  var existing = await fetchExistingChoices(
    client,
    params.table,
    params.column,
    values,
  );
  var existingByValue = groupExistingByKey(existing);

  var results: Array<ChoiceRemovalResult> = [];
  for (var i = 0; i < values.length; i += 1) {
    var value = values[i];
    var matches = existingByValue[language + "::" + value] || [];
    if (matches.length === 0) {
      results.push({ value: value, sysId: "", sysIds: [], action: "missing" });
      continue;
    }
    var sysIds = matches.map(function (row) {
      return row.sys_id;
    });
    // Deactivate EVERY live row for this value. A field can hold more than one, and
    // stopping at the first leaves the choice selectable while reporting success.
    var active = matches.filter(function (row) {
      return row.inactive !== "true";
    });
    if (active.length === 0) {
      results.push({
        value: value,
        sysId: sysIds[0],
        sysIds: sysIds,
        action: "unchanged",
      });
      continue;
    }
    for (var a = 0; a < active.length; a += 1) {
      await client.claude.pushWithUpdateSet({
        update_set_sys_id: params.updateSetSysId,
        table: "sys_choice",
        record_sys_id: active[a].sys_id,
        fields: { inactive: "true" },
      });
    }
    results.push({
      value: value,
      sysId: sysIds[0],
      sysIds: sysIds,
      action: "deactivated",
    });
  }

  return {
    field: {
      table: params.table,
      column: params.column,
      language: language,
      dictionarySysId: dict.sys_id,
    },
    updateSet: { sysId: updateSet.sys_id, name: updateSet.name },
    choices: results,
  };
}
