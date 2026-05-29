/**
 * SincUtilsMS — base class for the Sincronia REST API.
 * Ported from x_nuvo_sinc to global scope so Tenon owns the full read surface
 * (manifest, bulk download, app list, current scope, ATF push).
 *
 * Deploy to: Global Scope > Script Includes
 * Name: SincUtilsMS
 * api_name: global.SincUtilsMS
 * sys_id: 884a272c334887107b18bc534d5c7b97
 * Accessible from: All application scopes
 */
var SincUtilsMS = Class.create();
SincUtilsMS.prototype = {
  initialize: function () {
    this.type = "SincUtilsMS";
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

  getScopeId: function (scopeName) {
    var appGR = new GlideRecord("sys_app");
    appGR.get("scope", scopeName);
    return appGR.getValue("sys_id");
  },

  getTableNames: function (config) {
    var scopeId = config.scopeId;
    var includes = config.includes;
    var excludes = config.excludes;
    var tables = [];
    var appFilesAgg = new GlideAggregate("sys_metadata");
    appFilesAgg.addQuery("sys_scope", "=", scopeId);
    appFilesAgg.groupBy("sys_class_name");
    appFilesAgg.query();

    while (appFilesAgg.next()) {
      var tableName = appFilesAgg.getValue("sys_class_name");
      var tableExcluded =
        tableName in excludes &&
        typeof excludes[tableName] !== "object" &&
        excludes[tableName] !== false;
      var tableIncluded =
        tableName in includes && includes[tableName] !== false;

      if (!tableExcluded || tableIncluded) {
        tables.push(tableName);
      }
    }

    return tables;
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
      excludes: excludes
    });

    for (var i = 0; i < tableNames.length; i++) {
      var tableName = tableNames[i];
      var tableMap = this.buildTableMap({
        tableName: tableName,
        scopeId: scopeId,
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
    var recGR = new GlideRecord(tableName);
    recGR.addQuery("sys_scope", scopeId);
    recGR.addQuery("sys_class_name", tableName);

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
            "SincUtilsMS: Failed to add metadata for record " + recName + ": " + e.message
          );
        }
      }

      records[recName] = {
        files: files,
        name: recName,
        sys_id: recordSysId
      };
    }

    return {
      records: records
    };
  },

  generateRecordName: function (recGR, tableOptions) {
    var recordName = recGR.getDisplayValue() || recGR.getValue("sys_id");

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

    // Explicit field overrides win — sinc.config.js entries like
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
              "SincUtilsMS: Failed to add metadata for record " + recName + ": " + e.message
            );
          }

          tableMap.records[recName] = metaRecord;
        }
      }

      fileTableMap[tableName] = tableMap;
    }

    return fileTableMap;
  },

  getCurrentScope: function () {
    var scopeID = gs.getCurrentApplicationId();
    if (scopeID) {
      var appGR = new GlideRecord("sys_app");
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
    var appGR = new GlideRecord("sys_app");
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

  type: "SincUtilsMS"
};
