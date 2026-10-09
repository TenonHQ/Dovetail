/**
 * DovetailUtilsMS — base class for the Dovetail REST API.
 * Ported from legacy upstream to global scope so Tenon owns the full read surface
 * (manifest, bulk download, app list, current scope, ATF push).
 *
 * Deploy to: Global Scope > Script Includes (app "Dovetail", sys_scope 5f33b5d433d90b147b18bc534d5c7bf6)
 * Name: DovetailUtilsMS
 * api_name: global.DovetailUtilsMS
 * sys_id: 12e1ce1c335d0b147b18bc534d5c7be1 (tenonworkstudio; 884a272c… is the dead SincUtilsMS)
 * Accessible from: All application scopes
 *
 * Not synced by dove (global scope) — deploy with `dove-sn set-field --table sys_script_include
 * --sys-id <sys_id> --from-json <{script}> --update-set <Dovetail-scope set>` and read back.
 */
var DovetailUtilsMS = Class.create();
DovetailUtilsMS.prototype = {
  initialize: function () {
    this.type = "DovetailUtilsMS";
    this.typeMap = {
      css: "css",
      html: "html",
      html_script: "html",
      html_template: "html",
      script: "js",
      script_plain: "js",
      script_server: "js",
      xml: "xml"
    };
  },

  // App records live in sys_scope's child tables: sys_app for an app built on the
  // instance, sys_store_app for one installed from the app repo or the Store (every
  // x_cadso app on a customer or demo instance). Query the parent so both resolve.
  APP_CLASSES: "sys_app,sys_store_app",

  // Returns the app's sys_id, or "" when no app (or more than one) carries the name.
  // Every global-scope app shares the name "global", so it never resolves here.
  getScopeId: function (scopeName) {
    if (!scopeName) {
      return "";
    }
    var scopeGR = new GlideRecord("sys_scope");
    scopeGR.addQuery("scope", scopeName);
    scopeGR.addQuery("sys_class_name", "IN", this.APP_CLASSES);
    scopeGR.query();
    // Count by iterating (not getRowCount) so a second match means "ambiguous".
    var scopeId = "";
    while (scopeGR.next()) {
      if (scopeId) {
        return "";
      }
      scopeId = scopeGR.getValue("sys_id") || "";
    }
    return scopeId;
  },

  getTableNames: function (config) {
    var scopeId = config.scopeId;
    var includes = config.includes;
    var excludes = config.excludes;
    var tableOptions = config.tableOptions === undefined ? {} : config.tableOptions;
    var tables = [];
    var appFilesAgg = new GlideAggregate("sys_metadata");
    appFilesAgg.addQuery("sys_scope", "=", scopeId);
    appFilesAgg.groupBy("sys_class_name");
    appFilesAgg.query();

    while (appFilesAgg.next()) {
      var tableName = appFilesAgg.getValue("sys_class_name");

      if (this.isTableAllowed(tableName, includes, excludes)) {
        tables.push(tableName);
      }
    }

    // A table that carries no sys_scope (sys_choice is the canonical case: every
    // row's sys_scope is empty, so it is never a sys_metadata child of any app)
    // can never be discovered by the aggregate above. When dove.config.js gives
    // such a table a `scopeQuery`, it is listed explicitly here and filtered by
    // that query in buildTableMap instead of by sys_scope.
    for (var optTable in tableOptions) {
      var opts = tableOptions[optTable];
      var hasScopeQuery =
        opts && typeof opts === "object" && typeof opts.scopeQuery === "string" && opts.scopeQuery !== "";

      if (hasScopeQuery && tables.indexOf(optTable) === -1 && this.isTableAllowed(optTable, includes, excludes)) {
        tables.push(optTable);
      }
    }

    return tables;
  },

  isTableAllowed: function (tableName, includes, excludes) {
    var tableExcluded =
      tableName in excludes && typeof excludes[tableName] !== "object" && excludes[tableName] !== false;
    var tableIncluded = tableName in includes && includes[tableName] !== false;

    return !tableExcluded || tableIncluded;
  },

  // Render a `scopeQuery` table option into an encoded query for one scope.
  // `{scope}` → the app scope name (x_cadso_automate), `{scopeId}` → its sys_id.
  resolveScopeQuery: function (scopeQuery, scopeName, scopeId) {
    return String(scopeQuery)
      .replace(/\{scope\}/g, scopeName || "")
      .replace(/\{scopeId\}/g, scopeId || "");
  },

  // Fail-closed gate for a `scopeQuery`. ServiceNow silently drops an encoded-query
  // term on an unknown column, so a typo'd scopeQuery would return the WHOLE table
  // (sys_choice: >200k rows) — and because the table is listed for every scope, every
  // scope's manifest/bulk download would walk it. Returns { ok, query, reason }; the
  // caller must not run the query unless ok is true.
  //
  // Rules: the template must carry {scope} or {scopeId}, and each token it uses must
  // render non-empty; ^NQ is refused; every ^ / ^OR term must be "<field><operator>…"
  // (or ORDERBY/ORDERBYDESC<field>) with a field recGR.isValidField() accepts.
  // Dot-walked fields cannot be verified here, so they are refused.
  validateScopeQuery: function (recGR, scopeQuery, scopeName, scopeId) {
    var template = String(scopeQuery);
    var usesScope = template.indexOf("{scope}") !== -1;
    var usesScopeId = template.indexOf("{scopeId}") !== -1;

    if (!usesScope && !usesScopeId) {
      return {
        ok: false,
        reason: "it has no {scope} or {scopeId} token, so it would pull the same rows into every scope"
      };
    }

    if ((usesScope && !scopeName) || (usesScopeId && !scopeId)) {
      return {
        ok: false,
        reason: "a scope token renders empty (scope name or sys_id not resolved)"
      };
    }

    if (!recGR || typeof recGR.isValidField !== "function") {
      return { ok: false, reason: "field names cannot be verified on this table" };
    }

    var query = this.resolveScopeQuery(template, scopeName, scopeId);

    if (query.indexOf("^NQ") !== -1) {
      return { ok: false, reason: "^NQ (new query) is not allowed — it escapes the scope bound" };
    }

    var terms = query.split("^");

    for (var t = 0; t < terms.length; t++) {
      var term = terms[t];
      var field = "";

      if (term === "") {
        return { ok: false, reason: "it contains an empty term (^^ or a leading/trailing ^)" };
      }

      if (term.indexOf("ORDERBYDESC") === 0) {
        field = term.substring("ORDERBYDESC".length);
      } else if (term.indexOf("ORDERBY") === 0) {
        field = term.substring("ORDERBY".length);
      } else {
        if (t > 0 && term.indexOf("OR") === 0) {
          term = term.substring(2);
        }

        var fieldMatch = /^[a-z0-9_.]+/.exec(term);
        field = fieldMatch ? fieldMatch[0] : "";
        var rest = term.substring(field.length);

        if (field === "") {
          return { ok: false, reason: "term '" + terms[t] + "' does not start with a field name" };
        }

        if (rest === "" || !/^[A-Z=!<>]/.test(rest)) {
          return {
            ok: false,
            reason: "term '" + terms[t] + "' has no recognisable operator after field '" + field + "'"
          };
        }
      }

      if (field.indexOf(".") !== -1) {
        return {
          ok: false,
          reason: "dot-walked field '" + field + "' cannot be verified — use a column on the table itself"
        };
      }

      if (field === "" || !recGR.isValidField(field)) {
        return {
          ok: false,
          reason: "field '" + field + "' does not exist on the table (ServiceNow would ignore the term and return every row)"
        };
      }
    }

    return { ok: true, query: query };
  },

  getManifest: function (config) {
    var scopeName = config.scopeName;
    var getContents = config.getContents === undefined ? false : config.getContents;
    var includes = config.includes;
    var excludes = config.excludes;
    var tableOptions = config.tableOptions === undefined ? {} : config.tableOptions;
    var scopeId = this.getScopeId(scopeName);
    var tables = {};
    var tableNames = this.getTableNames({
      scopeId: scopeId,
      includes: includes,
      excludes: excludes,
      tableOptions: tableOptions
    });

    for (var i = 0; i < tableNames.length; i++) {
      var tableName = tableNames[i];
      var tableMap = this.buildTableMap({
        tableName: tableName,
        scopeId: scopeId,
        scopeName: scopeName,
        includes: includes,
        excludes: excludes,
        getContents: getContents,
        tableOptions: tableOptions[tableName] || {}
      });
      var records = Object.keys(tableMap.records);

      if (records.length === 0) {
        continue;
      }

      tables[tableName] = tableMap;
    }

    return {
      tables: tables,
      scope: scopeName
    };
  },

  buildTableMap: function (config) {
    var tableName = config.tableName;
    var scopeId = config.scopeId;
    var scopeName = config.scopeName;
    var getContents = config.getContents;
    var includes = config.includes;
    var excludes = config.excludes;
    var tableOptions = config.tableOptions;
    var results = {
      records: {}
    };
    var fieldListForTable = this.getFileMap({
      tableName: tableName,
      includes: includes,
      excludes: excludes
    });

    if (Object.keys(fieldListForTable).length === 0) {
      return results;
    }

    var records = {};
    // Collected first, keyed into `records` only after every display name is known
    // — see the disambiguation pass after the loop.
    var pendingRecords = [];
    var nameCounts = {};
    var recGR = new GlideRecord(tableName);

    // Scope membership. Platform-config tables that carry no sys_scope (sys_choice)
    // declare a `scopeQuery` instead — an encoded query with a {scope} token, e.g.
    // "nameSTARTSWITH{scope}_" — which replaces the sys_scope filter outright.
    // The query is validated first and refused (empty map, query() never runs) if
    // it cannot be proven to stay inside the scope — see validateScopeQuery.
    if (typeof tableOptions.scopeQuery === "string" && tableOptions.scopeQuery !== "") {
      var scopeCheck = this.validateScopeQuery(recGR, tableOptions.scopeQuery, scopeName, scopeId);

      if (!scopeCheck.ok) {
        gs.warn(
          "DovetailUtilsMS: refusing scopeQuery for " +
            tableName +
            " ('" +
            tableOptions.scopeQuery +
            "'): " +
            scopeCheck.reason +
            ". No records returned for this table."
        );
        return results;
      }

      recGR.addEncodedQuery(scopeCheck.query);
    } else {
      recGR.addQuery("sys_scope", scopeId);
    }

    // Flat tables (sys_choice, sys_dictionary) have no sys_class_name column; an
    // addQuery on a column the table lacks is ignored by the platform, but guard it
    // so the intent is explicit rather than relying on that leniency.
    if (typeof recGR.isValidField !== "function" || recGR.isValidField("sys_class_name")) {
      recGR.addQuery("sys_class_name", tableName);
    }

    if (tableOptions.query !== undefined) {
      recGR.addEncodedQuery(tableOptions.query);
    }

    recGR.query();

    while (recGR.next()) {
      var files = Object.keys(fieldListForTable).map(function (key) {
        var file = {
          name: fieldListForTable[key].name,
          type: fieldListForTable[key].type
        };

        if (getContents) {
          file.content = recGR.getValue(key);
        }

        return file;
      });

      var recName = this.generateRecordName(recGR, tableOptions);
      var recordSysId = recGR.getValue("sys_id");

      if (getContents) {
        try {
          var recordMetadata = {};
          var elements = recGR.getElements();
          // getElements() returns a Java collection whose `.length` is undefined in
          // the global/REST execution context, so the legacy `j < elements.length`
          // loop never iterated and metaData captured no record fields (only the
          // underscore keys below). Resolve a real count via size()/get(), falling
          // back to array indexing where `.length` is a number.
          var useIndex = elements != null && typeof elements.length === "number";
          var elementCount = 0;
          if (elements != null) {
            elementCount = useIndex ? elements.length : elements.size ? elements.size() : 0;
          }

          for (var j = 0; j < elementCount; j++) {
            var element = useIndex ? elements[j] : elements.get(j);
            var fieldName = element.getName() + "";

            recordMetadata[fieldName] = {
              value: recGR.getValue(fieldName),
              display_value: recGR.getDisplayValue(fieldName)
            };
          }

          recordMetadata._table = tableName;
          recordMetadata._sys_id = recordSysId;
          recordMetadata._name = recName;
          recordMetadata._record_link =
            gs.getProperty("glide.servlet.uri") + tableName + ".do?sys_id=" + recordSysId;
          recordMetadata._localOnly = true;
          recordMetadata._lastUpdatedOn = recGR.getValue("sys_updated_on");
          recordMetadata._description =
            "Complete field metadata for record - DO NOT SYNC TO SERVICENOW";

          files.push({
            name: "metaData",
            type: "json",
            content: JSON.stringify(recordMetadata, null, 2)
          });
        } catch (e) {
          gs.warn(
            "DovetailUtilsMS: Failed to add metadata for record " + recName + ": " + e.message
          );
        }
      }

      pendingRecords.push({
        displayName: recName,
        sys_id: recordSysId,
        files: files
      });
      nameCounts[recName] = (nameCounts[recName] || 0) + 1;
    }

    // `records` is keyed by display name, so two records sharing one used to
    // silently overwrite each other: one vanished from the manifest entirely (no
    // warning, no error), and because the survivor kept the shared folder, a later
    // push to that folder wrote to the WRONG record.
    //
    // Suffix EVERY member of a colliding set, not just the later ones. Suffixing
    // only the duplicate would leave "which record keeps the bare name" dependent on
    // GlideRecord query order, so folder names could churn between refreshes.
    //
    // The record's true display name is preserved in metaData.json (`_name`); this
    // only changes the manifest key / folder name. Mirrors the client-side guard in
    // normalizeManifestKeys (packages/core/src/appUtils.ts), which never fired
    // because the collapse had already happened here, server-side.
    for (var p = 0; p < pendingRecords.length; p++) {
      var pending = pendingRecords[p];
      var recordName = pending.displayName;

      if (nameCounts[recordName] > 1) {
        recordName = recordName + " (" + pending.sys_id.substring(0, 8) + ")";
        gs.warn(
          "DovetailUtilsMS: duplicate display name '" +
            pending.displayName +
            "' in " +
            tableName +
            " — writing it as '" +
            recordName +
            "'. Before this, one of these records was dropped from the manifest."
        );
      }

      records[recordName] = {
        files: pending.files,
        name: recordName,
        sys_id: pending.sys_id
      };
    }

    return {
      records: records
    };
  },

  // Render a `nameTemplate` table option ("{name}.{element}.{value}") against a
  // record. Each {token} is the raw value of that field. An EMPTY token is dropped
  // together with the literal that precedes it, so "{name}.{element}" on a
  // sys_dictionary collection row (element empty) yields the bare table name
  // rather than "table.". Returns "" when every token is empty.
  renderNameTemplate: function (recGR, template) {
    var pattern = /\{([A-Za-z0-9_]+)\}/g;
    var out = "";
    var lastIndex = 0;
    var match = pattern.exec(template);

    while (match !== null) {
      var literal = template.substring(lastIndex, match.index);
      var value = recGR.getValue(match[1]);

      if (value !== null && value !== undefined && String(value) !== "") {
        if (out !== "" || lastIndex === 0) {
          out += literal;
        }
        out += String(value);
      }

      lastIndex = match.index + match[0].length;
      match = pattern.exec(template);
    }

    if (out !== "") {
      out += template.substring(lastIndex);
    }

    return out;
  },

  generateRecordName: function (recGR, tableOptions) {
    var recordName = recGR.getDisplayValue() || recGR.getValue("sys_id");

    // nameTemplate is explicit and wins over displayField / differentiatorField.
    // Tables whose display value is not unique across a scope (sys_choice.label,
    // sys_dictionary.column_label) name their records from the fields that ARE:
    // "{name}.{element}.{value}" → x_cadso_automate_message_batch_recipient.last_status.delivered
    if (typeof tableOptions.nameTemplate === "string" && tableOptions.nameTemplate !== "") {
      var templated = this.renderNameTemplate(recGR, tableOptions.nameTemplate);
      return (templated || recGR.getValue("sys_id")).replace(/[\/\\]/g, "〳");
    }

    if (tableOptions.displayField !== undefined) {
      recordName = recGR.getElement(tableOptions.displayField).getDisplayValue();
    }

    if (tableOptions.differentiatorField !== undefined) {
      if (typeof tableOptions.differentiatorField === "string") {
        recordName =
          recordName +
          " (" +
          recGR.getElement(tableOptions.differentiatorField).getDisplayValue() +
          ")";
      }

      if (typeof tableOptions.differentiatorField === "object") {
        var diffArr = tableOptions.differentiatorField;

        for (var i = 0; i < diffArr.length; i++) {
          var field = diffArr[i];
          var val = recGR.getElement(field).getDisplayValue();

          if (val !== undefined && val !== "") {
            recordName = recordName + " (" + field + ":" + val + ")";
            break;
          }
        }
      }
    }

    if (!recordName || recordName === "") {
      recordName = recGR.getValue("sys_id");
    }

    return recordName.replace(/[\/\\]/g, "〳");
  },

  getFieldExcludes: function (config) {
    var tableName = config.tableName;
    var excludes = config.excludes;
    var excludesHasTable = tableName in excludes;

    if (excludesHasTable && typeof excludes[tableName] !== "boolean") {
      return excludes[tableName];
    }
  },

  getFilteredExcludes: function (config) {
    var tableName = config.tableName;
    var includes = config.includes;
    var exFields = this.getFieldExcludes(config);

    if (!exFields) {
      return [];
    }

    var excludedFields = Object.keys(exFields);
    var includesHasTable = tableName in includes;

    if (!includesHasTable) {
      return excludedFields;
    }

    var hasFieldLevel = typeof includes[tableName] !== "boolean";

    if (!hasFieldLevel) {
      return excludedFields;
    }

    var tableIncludes = includes[tableName];
    return excludedFields.filter(function (exField) {
      var fieldIncluded = exField in tableIncludes;

      if (!fieldIncluded) {
        return true;
      }

      if (fieldIncluded && typeof tableIncludes[exField] === "boolean") {
        return true;
      }
    });
  },

  getFileMap: function (config) {
    var tableName = config.tableName;
    var includes = config.includes;
    var fieldList = {};

    // Explicit field overrides win — dove.config.js entries like
    // sys_script_include: { script: { type: "js" } } are exclusive.
    if (tableName in includes && typeof includes[tableName] === "object") {
      for (var fieldName in includes[tableName]) {
        var fMap = includes[tableName][fieldName];
        fieldList[fieldName] = {
          name: fieldName,
          type: fMap.type || "txt"
        };
      }
      return fieldList;
    }

    // Default: discover script-typed fields from sys_dictionary for this table
    // (and its parents in the hierarchy). The earlier approach chained
    // separate addEncodedQuery calls with ^OR fragments — those leaked across
    // the AND boundary and returned every script/html/xml field in the
    // dictionary. addQuery + addOrCondition keeps each OR group scoped to its
    // own column so the AND between (name list) and (type list) holds.
    var tableHierarchy = new TableUtils(tableName);
    var tableList = [tableName];
    if (!tableHierarchy.isBaseClass() && !tableHierarchy.isSoloClass()) {
      // getTables() returns a Java ImmutableArrayList — copy into a JS array.
      var hierarchy = tableHierarchy.getTables();
      tableList = [];
      for (var h = 0; h < hierarchy.size(); h++) {
        tableList.push("" + hierarchy.get(h));
      }
    }
    var fieldTypes = Object.keys(this.typeMap);
    var fieldExcludes = this.getFilteredExcludes(config);

    var dictGR = new GlideRecord("sys_dictionary");

    var nameCond = dictGR.addQuery("name", tableList[0]);
    for (var i = 1; i < tableList.length; i++) {
      nameCond.addOrCondition("name", tableList[i]);
    }

    var typeCond = dictGR.addQuery("internal_type", fieldTypes[0]);
    for (var j = 1; j < fieldTypes.length; j++) {
      typeCond.addOrCondition("internal_type", fieldTypes[j]);
    }

    for (var k = 0; k < fieldExcludes.length; k++) {
      dictGR.addQuery("element", "!=", fieldExcludes[k]);
    }

    dictGR.query();

    while (dictGR.next()) {
      var field = {
        name: dictGR.getValue("element"),
        type: this.typeMap[dictGR.getValue("internal_type")]
      };
      fieldList[field.name] = field;
    }

    return fieldList;
  },

  processMissingFiles: function (missingObj, tableOptions) {
    var fileTableMap = {};

    for (var tableName in missingObj) {
      var tableGR = new GlideRecord(tableName);
      var recordMap = missingObj[tableName];
      var tableOpts = tableOptions[tableName] || {};
      var tableMap = {
        records: {}
      };
      // Same collision guard as buildTableMap. bulkDownload keys its response by
      // display name too, so without this the file CONTENT for one of a colliding
      // pair would still be dropped — even now that the manifest lists both.
      var pendingRecords = [];
      var nameCounts = {};

      for (var recordID in recordMap) {
        if (tableGR.get(recordID)) {
          var recName = this.generateRecordName(tableGR, tableOpts);
          var metaRecord = {
            name: recName,
            files: [],
            sys_id: tableGR.getValue("sys_id")
          };

          for (var i = 0; i < recordMap[recordID].length; i++) {
            var file = recordMap[recordID][i];
            file.content = tableGR.getValue(file.name);
            metaRecord.files.push(file);
          }

          try {
            var recordMetadata = {};
            var elements = tableGR.getElements();
            // getElements() returns a Java collection whose `.length` is undefined in
            // the global/REST execution context, so the legacy `j < elements.length`
            // loop never iterated and metaData captured no record fields (only the
            // underscore keys below). Resolve a real count via size()/get(), falling
            // back to array indexing where `.length` is a number.
            var useIndex = elements != null && typeof elements.length === "number";
            var elementCount = 0;
            if (elements != null) {
              elementCount = useIndex ? elements.length : elements.size ? elements.size() : 0;
            }

            for (var j = 0; j < elementCount; j++) {
              var element = useIndex ? elements[j] : elements.get(j);
              var fName = element.getName() + "";

              recordMetadata[fName] = {
                value: tableGR.getValue(fName),
                display_value: tableGR.getDisplayValue(fName)
              };
            }

            recordMetadata._table = tableName;
            recordMetadata._sys_id = recordID;
            recordMetadata._name = recName;
            recordMetadata._record_link =
              gs.getProperty("glide.servlet.uri") + tableName + ".do?sys_id=" + recordID;
            recordMetadata._localOnly = true;
            recordMetadata._lastUpdatedOn = tableGR.getValue("sys_updated_on");
            recordMetadata._description =
              "Complete field metadata for record - DO NOT SYNC TO SERVICENOW";

            metaRecord.files.push({
              name: "metaData",
              type: "json",
              content: JSON.stringify(recordMetadata, null, 2)
            });
          } catch (e) {
            gs.warn(
              "DovetailUtilsMS: Failed to add metadata for record " + recName + ": " + e.message
            );
          }

          pendingRecords.push({
            displayName: recName,
            record: metaRecord
          });
          nameCounts[recName] = (nameCounts[recName] || 0) + 1;
        }
      }

      for (var p = 0; p < pendingRecords.length; p++) {
        var pending = pendingRecords[p];
        var recordName = pending.displayName;

        if (nameCounts[recordName] > 1) {
          recordName = recordName + " (" + pending.record.sys_id.substring(0, 8) + ")";
          gs.warn(
            "DovetailUtilsMS: duplicate display name '" +
              pending.displayName +
              "' in " +
              tableName +
              " — writing it as '" +
              recordName +
              "'. Before this, one of these records was dropped from the bulkDownload response."
          );
        }

        // Keep record.name === the map key: every writer builds the folder path from
        // it, and push looks the record back up by folder name.
        pending.record.name = recordName;
        tableMap.records[recordName] = pending.record;
      }

      fileTableMap[tableName] = tableMap;
    }

    return fileTableMap;
  },

  getCurrentScope: function () {
    var scopeID = gs.getCurrentApplicationId();
    if (scopeID) {
      var appGR = new GlideRecord("sys_scope");
      if (appGR.get(scopeID)) {
        return {
          scope: appGR.getValue("scope") || "Global",
          sys_id: scopeID
        };
      }
    }
    return {
      scope: "Global",
      sys_id: "global"
    };
  },

  getAppList: function () {
    var results = [];
    var appGR = new GlideRecord("sys_scope");
    appGR.addQuery("sys_class_name", "IN", this.APP_CLASSES);
    appGR.query();

    while (appGR.next()) {
      results.push({
        displayName: appGR.getValue("name"),
        scope: appGR.getValue("scope"),
        sys_id: appGR.getValue("sys_id")
      });
    }

    return results;
  },

  pushATFfile: function (sysId, fileContents) {
    var gr = new GlideRecord("sys_atf_step");
    if (gr.get(sysId)) {
      gr.setValue("inputs.script", fileContents);
      return gr.update();
    }
    return false;
  },

  type: "DovetailUtilsMS"
};
