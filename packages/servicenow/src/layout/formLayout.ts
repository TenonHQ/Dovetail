/**
 * setFormLayout — declaratively reconcile a ServiceNow form layout.
 *
 * A form layout is a sys_ui_form row (keyed by table + view + global sys_user)
 * plus an ordered set of sections. Each section is a sys_ui_section definition
 * placed onto the form via a sys_ui_form_section join row, and each section
 * holds an ordered set of sys_ui_element field rows.
 *
 * The caller supplies the desired ordered sections (each with ordered fields);
 * this upserts the form, then creates / repositions / deletes the section join
 * rows and the per-section field rows so the layout matches — writing only the
 * delta through the Dovetail REST API so every change lands in the update set.
 *
 * Reconcile is two-level: the section list is diffed against the join rows
 * (keyed by section caption), then each section's fields are diffed against its
 * sys_ui_element rows — both with the shared diffChildren helper.
 */

import type { ServiceNowClient } from "../client";
import type {
  SetFormLayoutParams,
  LayoutResult,
  LayoutRecordResult,
} from "../types";
import {
  assertUpdateSet,
  resolveScope,
  resolveView,
  viewFields,
  normalizeViewValue,
  encodeQueryValue,
  diffChildren,
} from "./layoutCommon";
import type { ExistingChild } from "./layoutCommon";

/** Extract the plain value of a field that may be a { value, link } reference. */
function plain(raw: any): string {
  if (raw && typeof raw === "object") {
    return raw.value !== undefined ? raw.value : "";
  }
  return raw === undefined || raw === null ? "" : String(raw);
}

/** Dedupe an ordered list of strings, keeping first occurrence. */
function dedupe(values: Array<string>): Array<string> {
  var seen: Record<string, boolean> = {};
  var out: Array<string> = [];
  values.forEach(function (v) {
    if (!seen[v]) {
      seen[v] = true;
      out.push(v);
    }
  });
  return out;
}

/** A desired section once its sys_ui_section row has been resolved (or planned). */
interface ResolvedSection {
  /** Section caption — "" for the primary section. */
  caption: string;
  /** sys_id of the sys_ui_section row; "" when only planned under dryRun. */
  sysId: string;
  /** Deduped, ordered field (element) names. */
  fields: Array<string>;
}

/** An existing sys_ui_section row for the table + view. */
interface ExistingSection {
  sysId: string;
  caption: string;
}

/** A human-readable label for a section: its caption, or "(primary)" when blank. */
function sectionLabel(caption: string): string {
  return caption === "" ? "(primary)" : caption;
}

export async function setFormLayout(
  client: ServiceNowClient,
  params: SetFormLayoutParams,
): Promise<LayoutResult> {
  if (!params.table) {
    throw new Error("table is required.");
  }
  if (!params.sections || params.sections.length === 0) {
    throw new Error("sections must be a non-empty array.");
  }
  var prune = params.prune !== false;
  var dryRun = params.dryRun === true;

  // Normalize each desired section: a missing caption is the primary section
  // (""), and each section's fields are deduped (first occurrence wins).
  var desiredSections: Array<{ caption: string; fields: Array<string> }> = [];
  var captionSeen: Record<string, boolean> = {};
  for (var s = 0; s < params.sections.length; s += 1) {
    var spec = params.sections[s];
    var caption = spec.caption || "";
    if (Object.prototype.hasOwnProperty.call(captionSeen, caption)) {
      throw new Error("duplicate section caption: " + JSON.stringify(caption));
    }
    captionSeen[caption] = true;
    desiredSections.push({
      caption: caption,
      fields: dedupe(spec.fields || []),
    });
  }

  var updateSet = await assertUpdateSet(client, params.updateSetSysId);
  var scope = await resolveScope(client, params.table, params.scope);
  var view = await resolveView(client, {
    viewName: params.view || "",
    updateSetSysId: params.updateSetSysId,
    scope: scope,
    dryRun: dryRun,
  });

  var records: Array<LayoutRecordResult> = [];
  // A named view that does not exist yet (only possible under dryRun) cannot
  // have any existing layout records to reconcile against.
  var viewMissing = view.name !== "" && view.sysId === "";
  var vf = viewFields(view);

  // ── 1. Resolve the sys_ui_form parent row (table + view + global sys_user).
  var form: any = null;
  if (!viewMissing) {
    var formRows = await client.table.query<any>(
      "sys_ui_form",
      "name=" + encodeQueryValue(params.table),
      200,
    );
    for (var fi = 0; fi < formRows.length; fi += 1) {
      var fr = formRows[fi];
      if (
        normalizeViewValue(fr.view) === view.sysId &&
        plain(fr.sys_user) === ""
      ) {
        form = fr;
        break;
      }
    }
  }
  var formSysId = form ? plain(form.sys_id) : "";

  if (form) {
    records.push({
      table: "sys_ui_form",
      sysId: formSysId,
      action: "unchanged",
      label: params.table,
    });
  } else if (dryRun) {
    records.push({
      table: "sys_ui_form",
      sysId: "",
      action: "created",
      label: params.table,
    });
  } else {
    var createdForm = await client.claude.createRecord({
      table: "sys_ui_form",
      fields: { name: params.table, view: vf.view, view_name: vf.view_name },
      scope: scope,
      update_set_sys_id: params.updateSetSysId,
    });
    formSysId = createdForm.sys_id;
    records.push({
      table: "sys_ui_form",
      sysId: formSysId,
      action: "created",
      label: params.table,
    });
  }

  // ── 2. Resolve the sys_ui_section rows — one per desired section, matched to
  // an existing section by caption, created when absent.
  var existingSections: Array<ExistingSection> = [];
  if (formSysId && !viewMissing) {
    var secRows = await client.table.query<any>(
      "sys_ui_section",
      "name=" + encodeQueryValue(params.table),
      200,
    );
    for (var si = 0; si < secRows.length; si += 1) {
      var secRow = secRows[si];
      if (
        normalizeViewValue(secRow.view) === view.sysId &&
        plain(secRow.sys_user) === ""
      ) {
        existingSections.push({
          sysId: plain(secRow.sys_id),
          caption: plain(secRow.caption),
        });
      }
    }
  }

  var resolvedSections: Array<ResolvedSection> = [];
  for (var d = 0; d < desiredSections.length; d += 1) {
    var want = desiredSections[d];
    var matchSec: ExistingSection | null = null;
    for (var es = 0; es < existingSections.length; es += 1) {
      if (existingSections[es].caption === want.caption) {
        matchSec = existingSections[es];
        break;
      }
    }
    if (matchSec) {
      resolvedSections.push({
        caption: want.caption,
        sysId: matchSec.sysId,
        fields: want.fields,
      });
      records.push({
        table: "sys_ui_section",
        sysId: matchSec.sysId,
        action: "unchanged",
        label: sectionLabel(want.caption),
      });
    } else if (dryRun) {
      resolvedSections.push({
        caption: want.caption,
        sysId: "",
        fields: want.fields,
      });
      records.push({
        table: "sys_ui_section",
        sysId: "",
        action: "created",
        label: sectionLabel(want.caption),
      });
    } else {
      var createdSec = await client.claude.createRecord({
        table: "sys_ui_section",
        fields: {
          name: params.table,
          view: vf.view,
          view_name: vf.view_name,
          caption: want.caption,
          header: "false",
          title: want.caption ? "true" : "false",
        },
        scope: scope,
        update_set_sys_id: params.updateSetSysId,
      });
      resolvedSections.push({
        caption: want.caption,
        sysId: createdSec.sys_id,
        fields: want.fields,
      });
      records.push({
        table: "sys_ui_section",
        sysId: createdSec.sys_id,
        action: "created",
        label: sectionLabel(want.caption),
      });
    }
  }

  // Map caption -> resolved sys_id, for the join-row create step.
  var sectionSysIdByCaption: Record<string, string> = {};
  for (var rs = 0; rs < resolvedSections.length; rs += 1) {
    sectionSysIdByCaption[resolvedSections[rs].caption] =
      resolvedSections[rs].sysId;
  }

  // ── 3. Reconcile the sys_ui_form_section join rows (which sections sit on the
  // form, and in what order). Keyed by the caption of the section they point to.
  var captionBySectionSysId: Record<string, string> = {};
  for (var xs = 0; xs < existingSections.length; xs += 1) {
    captionBySectionSysId[existingSections[xs].sysId] =
      existingSections[xs].caption;
  }
  var existingJoins: Array<ExistingChild> = [];
  var joinSectionSysIdByKey: Record<string, string> = {};
  if (formSysId) {
    var joinRows = await client.table.query<any>(
      "sys_ui_form_section",
      "sys_ui_form=" + encodeQueryValue(formSysId),
      200,
    );
    for (var ji = 0; ji < joinRows.length; ji += 1) {
      var joinRow = joinRows[ji];
      var pointedSecSysId = plain(joinRow.sys_ui_section);
      // Key the join by the caption of the section it places. A join pointing
      // at an unknown section keys on the raw section sys_id so diffChildren
      // treats it as an extra (pruned / repositioned, never matched).
      var joinKey = Object.prototype.hasOwnProperty.call(
        captionBySectionSysId,
        pointedSecSysId,
      )
        ? captionBySectionSysId[pointedSecSysId]
        : pointedSecSysId;
      existingJoins.push({
        sysId: plain(joinRow.sys_id),
        key: joinKey,
        position: Number(plain(joinRow.position)) || 0,
      });
      joinSectionSysIdByKey[joinKey] = pointedSecSysId;
    }
  }

  var desiredCaptions = resolvedSections.map(function (r) {
    return r.caption;
  });
  var joinPlan = formSysId
    ? diffChildren(desiredCaptions, existingJoins, prune)
    : [];

  // ── 4. Reconcile sys_ui_element rows per section. Only sections with a real
  // sys_id can have existing rows; freshly created sections start empty.
  interface ElementPlan {
    sectionSysId: string;
    caption: string;
    plan: Array<ReturnType<typeof diffChildren>[number]>;
  }
  var elementPlans: Array<ElementPlan> = [];
  for (var ep = 0; ep < resolvedSections.length; ep += 1) {
    var section = resolvedSections[ep];
    if (!section.sysId) {
      // Planned-only section (dryRun) — every field is a create.
      elementPlans.push({
        sectionSysId: "",
        caption: section.caption,
        plan: diffChildren(section.fields, [], prune),
      });
      continue;
    }
    var existingEls: Array<ExistingChild> = [];
    if (!viewMissing) {
      var elRows = await client.table.query<any>(
        "sys_ui_element",
        "sys_ui_section=" + encodeQueryValue(section.sysId),
        500,
      );
      existingEls = elRows.map(function (e: any): ExistingChild {
        return {
          sysId: plain(e.sys_id),
          key: plain(e.element),
          position: Number(plain(e.position)) || 0,
        };
      });
    }
    elementPlans.push({
      sectionSysId: section.sysId,
      caption: section.caption,
      plan: diffChildren(section.fields, existingEls, prune),
    });
  }

  // Record every "unchanged" element row up front (apply order mirrors listLayout).
  for (var uep = 0; uep < elementPlans.length; uep += 1) {
    var uplan = elementPlans[uep].plan;
    for (var ue = 0; ue < uplan.length; ue += 1) {
      if (uplan[ue].action === "unchanged") {
        records.push({
          table: "sys_ui_element",
          sysId: uplan[ue].sysId,
          action: "unchanged",
          label: uplan[ue].key,
        });
      }
    }
  }
  // Record every "unchanged" join row.
  for (var ujp = 0; ujp < joinPlan.length; ujp += 1) {
    if (joinPlan[ujp].action === "unchanged") {
      records.push({
        table: "sys_ui_form_section",
        sysId: joinPlan[ujp].sysId,
        action: "unchanged",
        label: sectionLabel(joinPlan[ujp].key),
      });
    }
  }

  // ── 5. dryRun: report the planned join + element deltas, write nothing.
  if (dryRun) {
    for (var dj = 0; dj < joinPlan.length; dj += 1) {
      var djs = joinPlan[dj];
      if (djs.action === "create") {
        records.push({
          table: "sys_ui_form_section",
          sysId: "",
          action: "created",
          label: sectionLabel(djs.key),
        });
      } else if (djs.action === "update") {
        records.push({
          table: "sys_ui_form_section",
          sysId: djs.sysId,
          action: "updated",
          label: sectionLabel(djs.key),
        });
      } else if (djs.action === "delete") {
        records.push({
          table: "sys_ui_form_section",
          sysId: djs.sysId,
          action: "deleted",
          label: sectionLabel(djs.key),
        });
      }
    }
    for (var de = 0; de < elementPlans.length; de += 1) {
      var deplan = elementPlans[de].plan;
      for (var dee = 0; dee < deplan.length; dee += 1) {
        var dees = deplan[dee];
        if (dees.action === "create") {
          records.push({
            table: "sys_ui_element",
            sysId: "",
            action: "created",
            label: dees.key,
          });
        } else if (dees.action === "update") {
          records.push({
            table: "sys_ui_element",
            sysId: dees.sysId,
            action: "updated",
            label: dees.key,
          });
        } else if (dees.action === "delete") {
          records.push({
            table: "sys_ui_element",
            sysId: dees.sysId,
            action: "deleted",
            label: dees.key,
          });
        }
      }
    }
    return {
      table: params.table,
      view: view.name,
      updateSet: updateSet,
      dryRun: true,
      records: records,
    };
  }

  // ── 6. Apply: creates first, then updates, then deletes (deletes pinned to the
  // update set). Section sys_ui_section rows were already created above so the
  // join + element creates below can reference them safely.

  // 6a. Join-row creates.
  for (var jc = 0; jc < joinPlan.length; jc += 1) {
    if (joinPlan[jc].action !== "create") {
      continue;
    }
    var createdJoin = await client.claude.createRecord({
      table: "sys_ui_form_section",
      fields: {
        sys_ui_form: formSysId,
        sys_ui_section: sectionSysIdByCaption[joinPlan[jc].key],
        position: String(joinPlan[jc].position),
      },
      scope: scope,
      update_set_sys_id: params.updateSetSysId,
    });
    records.push({
      table: "sys_ui_form_section",
      sysId: createdJoin.sys_id,
      action: "created",
      label: sectionLabel(joinPlan[jc].key),
    });
  }

  // 6b. Element creates, per section.
  for (var ec = 0; ec < elementPlans.length; ec += 1) {
    var ecEntry = elementPlans[ec];
    for (var ecp = 0; ecp < ecEntry.plan.length; ecp += 1) {
      if (ecEntry.plan[ecp].action !== "create") {
        continue;
      }
      var createdEl = await client.claude.createRecord({
        table: "sys_ui_element",
        fields: {
          sys_ui_section: ecEntry.sectionSysId,
          element: ecEntry.plan[ecp].key,
          position: String(ecEntry.plan[ecp].position),
        },
        scope: scope,
        update_set_sys_id: params.updateSetSysId,
      });
      records.push({
        table: "sys_ui_element",
        sysId: createdEl.sys_id,
        action: "created",
        label: ecEntry.plan[ecp].key,
      });
    }
  }

  // 6c. Join-row updates (reposition).
  for (var ju = 0; ju < joinPlan.length; ju += 1) {
    if (joinPlan[ju].action !== "update") {
      continue;
    }
    await client.claude.pushWithUpdateSet({
      update_set_sys_id: params.updateSetSysId,
      table: "sys_ui_form_section",
      record_sys_id: joinPlan[ju].sysId,
      fields: { position: String(joinPlan[ju].position) },
    });
    records.push({
      table: "sys_ui_form_section",
      sysId: joinPlan[ju].sysId,
      action: "updated",
      label: sectionLabel(joinPlan[ju].key),
    });
  }

  // 6d. Element updates (reposition), per section.
  for (var eu = 0; eu < elementPlans.length; eu += 1) {
    var euEntry = elementPlans[eu];
    for (var eup = 0; eup < euEntry.plan.length; eup += 1) {
      if (euEntry.plan[eup].action !== "update") {
        continue;
      }
      await client.claude.pushWithUpdateSet({
        update_set_sys_id: params.updateSetSysId,
        table: "sys_ui_element",
        record_sys_id: euEntry.plan[eup].sysId,
        fields: { position: String(euEntry.plan[eup].position) },
      });
      records.push({
        table: "sys_ui_element",
        sysId: euEntry.plan[eup].sysId,
        action: "updated",
        label: euEntry.plan[eup].key,
      });
    }
  }

  // 6e. Deletes — gather across joins, orphaned sections + their elements, and
  // per-section element deletes. A pruned join also tears down the section it
  // pointed at and every sys_ui_element under that section.
  interface PendingDelete {
    table: string;
    sysId: string;
    label: string;
  }
  var pendingDeletes: Array<PendingDelete> = [];

  for (var jd = 0; jd < joinPlan.length; jd += 1) {
    if (joinPlan[jd].action !== "delete") {
      continue;
    }
    var droppedKey = joinPlan[jd].key;
    pendingDeletes.push({
      table: "sys_ui_form_section",
      sysId: joinPlan[jd].sysId,
      label: sectionLabel(droppedKey),
    });
    var orphanSecSysId = joinSectionSysIdByKey[droppedKey] || "";
    if (orphanSecSysId) {
      // Delete the section's sys_ui_element children first, then the section.
      var orphanEls = await client.table.query<any>(
        "sys_ui_element",
        "sys_ui_section=" + encodeQueryValue(orphanSecSysId),
        500,
      );
      for (var oe = 0; oe < orphanEls.length; oe += 1) {
        pendingDeletes.push({
          table: "sys_ui_element",
          sysId: plain(orphanEls[oe].sys_id),
          label: plain(orphanEls[oe].element),
        });
      }
      pendingDeletes.push({
        table: "sys_ui_section",
        sysId: orphanSecSysId,
        label: sectionLabel(droppedKey),
      });
    }
  }

  for (var ed = 0; ed < elementPlans.length; ed += 1) {
    var edPlan = elementPlans[ed].plan;
    for (var edp = 0; edp < edPlan.length; edp += 1) {
      if (edPlan[edp].action === "delete") {
        pendingDeletes.push({
          table: "sys_ui_element",
          sysId: edPlan[edp].sysId,
          label: edPlan[edp].key,
        });
      }
    }
  }

  if (pendingDeletes.length > 0) {
    // deleteRecord has no update-set parameter — pin the REST session's active
    // update set once so every deletion is captured for promotion.
    await client.claude.changeUpdateSet({ sysId: params.updateSetSysId });
    for (var pd = 0; pd < pendingDeletes.length; pd += 1) {
      await client.claude.deleteRecord({
        table: pendingDeletes[pd].table,
        sys_id: pendingDeletes[pd].sysId,
      });
      records.push({
        table: pendingDeletes[pd].table,
        sysId: pendingDeletes[pd].sysId,
        action: "deleted",
        label: pendingDeletes[pd].label,
      });
    }
  }

  return {
    table: params.table,
    view: view.name,
    updateSet: updateSet,
    dryRun: false,
    records: records,
  };
}
