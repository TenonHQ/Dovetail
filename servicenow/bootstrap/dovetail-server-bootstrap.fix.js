/* ============================================================================
 * Dovetail Server Bootstrap - ONE-SHOT
 * ----------------------------------------------------------------------------
 * Stands up the Dovetail + Sincronia Scripted REST APIs INSIDE the Dovetail
 * scoped application, gated on the dovetail_user role.
 *
 * HOW TO RUN (honors "create in scope, update set open first"):
 *   1. Studio -> open the **Dovetail** app  (sys_app 5f33b5d433d90b147b18bc534d5c7bf6)
 *   2. Create + make active a NEW update set while Dovetail is the current app
 *   3. Create a **Fix Script** inside the Dovetail app, paste this whole file, Run
 *
 * The script HARD-ABORTS unless it is running in the Dovetail scope with an
 * active (non-Default) update set, so it cannot land records in the wrong place.
 * Idempotent: re-running updates in place (records keep their original sys_ids).
 * ==========================================================================*/
(function dovetailBootstrap() {
  var D = {
  "app": "5f33b5d433d90b147b18bc534d5c7bf6",
  "role_sys_id": "db33f5d433d90b147b18bc534d5c7b06",
  "wsds": [
    {
      "sys_id": "b8a9db8d33d7a6107b18bc534d5c7b7b",
      "name": "Dovetail",
      "namespace": "cadso",
      "service_id": "dovetail",
      "base_uri": "/api/cadso/dovetail"
    },
    {
      "sys_id": "afaa2facc30cc710d4ddf1db050131b0",
      "name": "Sincronia",
      "namespace": "sinc",
      "service_id": "sincronia",
      "base_uri": "/api/sinc/sincronia"
    }
  ],
  "sis": [
    {
      "sys_id": "b9aa2facc30cc710d4ddf1db0501317a",
      "name": "SincUtils",
      "api_name": "global.SincUtils",
      "script": "/**\n * SincUtils — entry-point class used by the Sincronia REST API operations.\n * Extends SincUtilsMS so individual operation scripts can `new SincUtils()` and\n * call helpers like getManifest, processMissingFiles, getAppList, etc.\n *\n * Deploy to: Global Scope > Script Includes\n * Name: SincUtils\n * api_name: global.SincUtils\n * sys_id: b9aa2facc30cc710d4ddf1db0501317a\n * Accessible from: All application scopes\n */\nvar SincUtils = Class.create();\nSincUtils.prototype = Object.extendsObject(SincUtilsMS, {\n  initialize: function () {\n    SincUtilsMS.prototype.initialize.call(this);\n    this.type = \"SincUtils\";\n  },\n\n  type: \"SincUtils\"\n});\n"
    },
    {
      "sys_id": "884a272c334887107b18bc534d5c7b97",
      "name": "SincUtilsMS",
      "api_name": "global.SincUtilsMS",
      "script": "/**\n * SincUtilsMS — base class for the Sincronia REST API.\n * Ported from x_nuvo_sinc to global scope so Tenon owns the full read surface\n * (manifest, bulk download, app list, current scope, ATF push).\n *\n * Deploy to: Global Scope > Script Includes\n * Name: SincUtilsMS\n * api_name: global.SincUtilsMS\n * sys_id: 884a272c334887107b18bc534d5c7b97\n * Accessible from: All application scopes\n */\nvar SincUtilsMS = Class.create();\nSincUtilsMS.prototype = {\n  initialize: function () {\n    this.type = \"SincUtilsMS\";\n    this.typeMap = {\n      css: \"css\",\n      html: \"html\",\n      html_script: \"html\",\n      html_template: \"html\",\n      script: \"js\",\n      script_plain: \"js\",\n      script_server: \"js\",\n      xml: \"xml\"\n    };\n  },\n\n  getScopeId: function (scopeName) {\n    var appGR = new GlideRecord(\"sys_app\");\n    appGR.get(\"scope\", scopeName);\n    return appGR.getValue(\"sys_id\");\n  },\n\n  getTableNames: function (config) {\n    var scopeId = config.scopeId;\n    var includes = config.includes;\n    var excludes = config.excludes;\n    var tables = [];\n    var appFilesAgg = new GlideAggregate(\"sys_metadata\");\n    appFilesAgg.addQuery(\"sys_scope\", \"=\", scopeId);\n    appFilesAgg.groupBy(\"sys_class_name\");\n    appFilesAgg.query();\n\n    while (appFilesAgg.next()) {\n      var tableName = appFilesAgg.getValue(\"sys_class_name\");\n      var tableExcluded =\n        tableName in excludes &&\n        typeof excludes[tableName] !== \"object\" &&\n        excludes[tableName] !== false;\n      var tableIncluded =\n        tableName in includes && includes[tableName] !== false;\n\n      if (!tableExcluded || tableIncluded) {\n        tables.push(tableName);\n      }\n    }\n\n    return tables;\n  },\n\n  getManifest: function (config) {\n    var scopeName = config.scopeName;\n    var getContents = config.getContents === undefined ? false : config.getContents;\n    var includes = config.includes;\n    var excludes = config.excludes;\n    var tableOptions = config.tableOptions === undefined ? {} : config.tableOptions;\n    var scopeId = this.getScopeId(scopeName);\n    var tables = {};\n    var tableNames = this.getTableNames({\n      scopeId: scopeId,\n      includes: includes,\n      excludes: excludes\n    });\n\n    for (var i = 0; i < tableNames.length; i++) {\n      var tableName = tableNames[i];\n      var tableMap = this.buildTableMap({\n        tableName: tableName,\n        scopeId: scopeId,\n        includes: includes,\n        excludes: excludes,\n        getContents: getContents,\n        tableOptions: tableOptions[tableName] || {}\n      });\n      var records = Object.keys(tableMap.records);\n\n      if (records.length === 0) {\n        continue;\n      }\n\n      tables[tableName] = tableMap;\n    }\n\n    return {\n      tables: tables,\n      scope: scopeName\n    };\n  },\n\n  buildTableMap: function (config) {\n    var tableName = config.tableName;\n    var scopeId = config.scopeId;\n    var getContents = config.getContents;\n    var includes = config.includes;\n    var excludes = config.excludes;\n    var tableOptions = config.tableOptions;\n    var results = {\n      records: {}\n    };\n    var fieldListForTable = this.getFileMap({\n      tableName: tableName,\n      includes: includes,\n      excludes: excludes\n    });\n\n    if (Object.keys(fieldListForTable).length === 0) {\n      return results;\n    }\n\n    var records = {};\n    var recGR = new GlideRecord(tableName);\n    recGR.addQuery(\"sys_scope\", scopeId);\n    recGR.addQuery(\"sys_class_name\", tableName);\n\n    if (tableOptions.query !== undefined) {\n      recGR.addEncodedQuery(tableOptions.query);\n    }\n\n    recGR.query();\n\n    while (recGR.next()) {\n      var files = Object.keys(fieldListForTable).map(function (key) {\n        var file = {\n          name: fieldListForTable[key].name,\n          type: fieldListForTable[key].type\n        };\n\n        if (getContents) {\n          file.content = recGR.getValue(key);\n        }\n\n        return file;\n      });\n\n      var recName = this.generateRecordName(recGR, tableOptions);\n      var recordSysId = recGR.getValue(\"sys_id\");\n\n      if (getContents) {\n        try {\n          var recordMetadata = {};\n          var elements = recGR.getElements();\n          // getElements() returns a Java collection whose `.length` is undefined in\n          // the global/REST execution context, so the legacy `j < elements.length`\n          // loop never iterated and metaData captured no record fields (only the\n          // underscore keys below). Resolve a real count via size()/get(), falling\n          // back to array indexing where `.length` is a number.\n          var useIndex = elements != null && typeof elements.length === \"number\";\n          var elementCount = 0;\n          if (elements != null) {\n            elementCount = useIndex ? elements.length : elements.size ? elements.size() : 0;\n          }\n\n          for (var j = 0; j < elementCount; j++) {\n            var element = useIndex ? elements[j] : elements.get(j);\n            var fieldName = element.getName() + \"\";\n\n            recordMetadata[fieldName] = {\n              value: recGR.getValue(fieldName),\n              display_value: recGR.getDisplayValue(fieldName)\n            };\n          }\n\n          recordMetadata._table = tableName;\n          recordMetadata._sys_id = recordSysId;\n          recordMetadata._name = recName;\n          recordMetadata._record_link =\n            gs.getProperty(\"glide.servlet.uri\") + tableName + \".do?sys_id=\" + recordSysId;\n          recordMetadata._localOnly = true;\n          recordMetadata._lastUpdatedOn = recGR.getValue(\"sys_updated_on\");\n          recordMetadata._description =\n            \"Complete field metadata for record - DO NOT SYNC TO SERVICENOW\";\n\n          files.push({\n            name: \"metaData\",\n            type: \"json\",\n            content: JSON.stringify(recordMetadata, null, 2)\n          });\n        } catch (e) {\n          gs.warn(\n            \"SincUtilsMS: Failed to add metadata for record \" + recName + \": \" + e.message\n          );\n        }\n      }\n\n      records[recName] = {\n        files: files,\n        name: recName,\n        sys_id: recordSysId\n      };\n    }\n\n    return {\n      records: records\n    };\n  },\n\n  generateRecordName: function (recGR, tableOptions) {\n    var recordName = recGR.getDisplayValue() || recGR.getValue(\"sys_id\");\n\n    if (tableOptions.displayField !== undefined) {\n      recordName = recGR.getElement(tableOptions.displayField).getDisplayValue();\n    }\n\n    if (tableOptions.differentiatorField !== undefined) {\n      if (typeof tableOptions.differentiatorField === \"string\") {\n        recordName =\n          recordName +\n          \" (\" +\n          recGR.getElement(tableOptions.differentiatorField).getDisplayValue() +\n          \")\";\n      }\n\n      if (typeof tableOptions.differentiatorField === \"object\") {\n        var diffArr = tableOptions.differentiatorField;\n\n        for (var i = 0; i < diffArr.length; i++) {\n          var field = diffArr[i];\n          var val = recGR.getElement(field).getDisplayValue();\n\n          if (val !== undefined && val !== \"\") {\n            recordName = recordName + \" (\" + field + \":\" + val + \")\";\n            break;\n          }\n        }\n      }\n    }\n\n    if (!recordName || recordName === \"\") {\n      recordName = recGR.getValue(\"sys_id\");\n    }\n\n    return recordName.replace(/[\\/\\\\]/g, \"〳\");\n  },\n\n  getFieldExcludes: function (config) {\n    var tableName = config.tableName;\n    var excludes = config.excludes;\n    var excludesHasTable = tableName in excludes;\n\n    if (excludesHasTable && typeof excludes[tableName] !== \"boolean\") {\n      return excludes[tableName];\n    }\n  },\n\n  getFilteredExcludes: function (config) {\n    var tableName = config.tableName;\n    var includes = config.includes;\n    var exFields = this.getFieldExcludes(config);\n\n    if (!exFields) {\n      return [];\n    }\n\n    var excludedFields = Object.keys(exFields);\n    var includesHasTable = tableName in includes;\n\n    if (!includesHasTable) {\n      return excludedFields;\n    }\n\n    var hasFieldLevel = typeof includes[tableName] !== \"boolean\";\n\n    if (!hasFieldLevel) {\n      return excludedFields;\n    }\n\n    var tableIncludes = includes[tableName];\n    return excludedFields.filter(function (exField) {\n      var fieldIncluded = exField in tableIncludes;\n\n      if (!fieldIncluded) {\n        return true;\n      }\n\n      if (fieldIncluded && typeof tableIncludes[exField] === \"boolean\") {\n        return true;\n      }\n    });\n  },\n\n  getFileMap: function (config) {\n    var tableName = config.tableName;\n    var includes = config.includes;\n    var fieldList = {};\n\n    // Explicit field overrides win — sinc.config.js entries like\n    // sys_script_include: { script: { type: \"js\" } } are exclusive.\n    if (tableName in includes && typeof includes[tableName] === \"object\") {\n      for (var fieldName in includes[tableName]) {\n        var fMap = includes[tableName][fieldName];\n        fieldList[fieldName] = {\n          name: fieldName,\n          type: fMap.type || \"txt\"\n        };\n      }\n      return fieldList;\n    }\n\n    // Default: discover script-typed fields from sys_dictionary for this table\n    // (and its parents in the hierarchy). The earlier approach chained\n    // separate addEncodedQuery calls with ^OR fragments — those leaked across\n    // the AND boundary and returned every script/html/xml field in the\n    // dictionary. addQuery + addOrCondition keeps each OR group scoped to its\n    // own column so the AND between (name list) and (type list) holds.\n    var tableHierarchy = new TableUtils(tableName);\n    var tableList = [tableName];\n    if (!tableHierarchy.isBaseClass() && !tableHierarchy.isSoloClass()) {\n      // getTables() returns a Java ImmutableArrayList — copy into a JS array.\n      var hierarchy = tableHierarchy.getTables();\n      tableList = [];\n      for (var h = 0; h < hierarchy.size(); h++) {\n        tableList.push(\"\" + hierarchy.get(h));\n      }\n    }\n    var fieldTypes = Object.keys(this.typeMap);\n    var fieldExcludes = this.getFilteredExcludes(config);\n\n    var dictGR = new GlideRecord(\"sys_dictionary\");\n\n    var nameCond = dictGR.addQuery(\"name\", tableList[0]);\n    for (var i = 1; i < tableList.length; i++) {\n      nameCond.addOrCondition(\"name\", tableList[i]);\n    }\n\n    var typeCond = dictGR.addQuery(\"internal_type\", fieldTypes[0]);\n    for (var j = 1; j < fieldTypes.length; j++) {\n      typeCond.addOrCondition(\"internal_type\", fieldTypes[j]);\n    }\n\n    for (var k = 0; k < fieldExcludes.length; k++) {\n      dictGR.addQuery(\"element\", \"!=\", fieldExcludes[k]);\n    }\n\n    dictGR.query();\n\n    while (dictGR.next()) {\n      var field = {\n        name: dictGR.getValue(\"element\"),\n        type: this.typeMap[dictGR.getValue(\"internal_type\")]\n      };\n      fieldList[field.name] = field;\n    }\n\n    return fieldList;\n  },\n\n  processMissingFiles: function (missingObj, tableOptions) {\n    var fileTableMap = {};\n\n    for (var tableName in missingObj) {\n      var tableGR = new GlideRecord(tableName);\n      var recordMap = missingObj[tableName];\n      var tableOpts = tableOptions[tableName] || {};\n      var tableMap = {\n        records: {}\n      };\n\n      for (var recordID in recordMap) {\n        if (tableGR.get(recordID)) {\n          var recName = this.generateRecordName(tableGR, tableOpts);\n          var metaRecord = {\n            name: recName,\n            files: [],\n            sys_id: tableGR.getValue(\"sys_id\")\n          };\n\n          for (var i = 0; i < recordMap[recordID].length; i++) {\n            var file = recordMap[recordID][i];\n            file.content = tableGR.getValue(file.name);\n            metaRecord.files.push(file);\n          }\n\n          try {\n            var recordMetadata = {};\n            var elements = tableGR.getElements();\n            // getElements() returns a Java collection whose `.length` is undefined in\n            // the global/REST execution context, so the legacy `j < elements.length`\n            // loop never iterated and metaData captured no record fields (only the\n            // underscore keys below). Resolve a real count via size()/get(), falling\n            // back to array indexing where `.length` is a number.\n            var useIndex = elements != null && typeof elements.length === \"number\";\n            var elementCount = 0;\n            if (elements != null) {\n              elementCount = useIndex ? elements.length : elements.size ? elements.size() : 0;\n            }\n\n            for (var j = 0; j < elementCount; j++) {\n              var element = useIndex ? elements[j] : elements.get(j);\n              var fName = element.getName() + \"\";\n\n              recordMetadata[fName] = {\n                value: tableGR.getValue(fName),\n                display_value: tableGR.getDisplayValue(fName)\n              };\n            }\n\n            recordMetadata._table = tableName;\n            recordMetadata._sys_id = recordID;\n            recordMetadata._name = recName;\n            recordMetadata._record_link =\n              gs.getProperty(\"glide.servlet.uri\") + tableName + \".do?sys_id=\" + recordID;\n            recordMetadata._localOnly = true;\n            recordMetadata._lastUpdatedOn = tableGR.getValue(\"sys_updated_on\");\n            recordMetadata._description =\n              \"Complete field metadata for record - DO NOT SYNC TO SERVICENOW\";\n\n            metaRecord.files.push({\n              name: \"metaData\",\n              type: \"json\",\n              content: JSON.stringify(recordMetadata, null, 2)\n            });\n          } catch (e) {\n            gs.warn(\n              \"SincUtilsMS: Failed to add metadata for record \" + recName + \": \" + e.message\n            );\n          }\n\n          tableMap.records[recName] = metaRecord;\n        }\n      }\n\n      fileTableMap[tableName] = tableMap;\n    }\n\n    return fileTableMap;\n  },\n\n  getCurrentScope: function () {\n    var scopeID = gs.getCurrentApplicationId();\n    if (scopeID) {\n      var appGR = new GlideRecord(\"sys_app\");\n      if (appGR.get(scopeID)) {\n        return {\n          scope: appGR.getValue(\"scope\") || \"Global\",\n          sys_id: scopeID\n        };\n      }\n    }\n    return {\n      scope: \"Global\",\n      sys_id: \"global\"\n    };\n  },\n\n  getAppList: function () {\n    var results = [];\n    var appGR = new GlideRecord(\"sys_app\");\n    appGR.query();\n\n    while (appGR.next()) {\n      results.push({\n        displayName: appGR.getValue(\"name\"),\n        scope: appGR.getValue(\"scope\"),\n        sys_id: appGR.getValue(\"sys_id\")\n      });\n    }\n\n    return results;\n  },\n\n  pushATFfile: function (sysId, fileContents) {\n    var gr = new GlideRecord(\"sys_atf_step\");\n    if (gr.get(sysId)) {\n      gr.setValue(\"inputs.script\", fileContents);\n      return gr.update();\n    }\n    return false;\n  },\n\n  type: \"SincUtilsMS\"\n};\n"
    }
  ],
  "ops": [
    {
      "sys_id": "fe3bbfc9339ba6107b18bc534d5c7b2d",
      "name": "Change Scope",
      "http_method": "GET",
      "relative_path": "/changeScope",
      "wsd": "b8a9db8d33d7a6107b18bc534d5c7b7b",
      "script": "(function process( /*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {\n    /* dovetail_user gate (injected by bootstrap) */\n    if (!gs.hasRole('dovetail_user') && !gs.hasRole('admin')) { response.setStatus(403); response.setBody({ error: 'dovetail_user role required' }); return response; }\n\n    let {\n        scope\n    } = request.queryParams;\n\n    // Handle array parameter\n    if (scope && typeof scope !== \"string\") {\n        scope = scope[0];\n    }\n\n    if (scope) {\n        var sysScopeGr = new GlideRecord('sys_scope');\n        sysScopeGr.addQuery('scope', scope);\n        sysScopeGr.query();\n\n        if (sysScopeGr.next()) {\n            var newScopeId = sysScopeGr.getUniqueValue();\n            gs.setCurrentApplicationId(newScopeId);\n\n            response.setBody({\n                message: 'Success',\n                scopeId: newScopeId,\n                scope: scope,\n                user: gs.getUserDisplayName(),\n                instance: gs.getProperty('instance_name')\n            });\n            response.setStatus(200);\n        } else {\n            response.setStatus(404);\n            response.setBody({\n                error: 'Scope not found!'\n            });\n        }\n    } else {\n        response.setStatus(400);\n        response.setBody({\n            error: 'No scope provided'\n        });\n    }\n\n    return response;\n\n})(request, response);"
    },
    {
      "sys_id": "95b9db8d33d7a6107b18bc534d5c7b6f",
      "name": "Change Update Set",
      "http_method": "GET",
      "relative_path": "/changeUpdateSet",
      "wsd": "b8a9db8d33d7a6107b18bc534d5c7b7b",
      "script": "(function process( /*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {\n    /* dovetail_user gate (injected by bootstrap) */\n    if (!gs.hasRole('dovetail_user') && !gs.hasRole('admin')) { response.setStatus(403); response.setBody({ error: 'dovetail_user role required' }); return response; }\n\n    let {\n        sysId,\n        name,\n        scope\n    } = request.queryParams;\n    if (typeof sysId !== \"string\") {\n        sysId = sysId[0];\n    }\n    if (typeof name !== \"string\") {\n        name = name[0];\n    }\n    if (typeof scope !== \"string\") {\n        scope = scope[0];\n    }\n\n    if (!sysId) {\n        const sysUpdateSetGr = new GlideRecord('sys_update_set');\n        sysUpdateSetGr.addEncodedQuery(`application.scopeLIKE${scope}`);\n        sysUpdateSetGr.addQuery('name', 'LIKE', name);\n        sysUpdateSetGr.addQuery('state', '=', 'in progress');\n        sysUpdateSetGr.setLimit(1);\n        sysUpdateSetGr.orderByDesc('sys_created_on');\n        sysUpdateSetGr.query();\n\n        while (sysUpdateSetGr.next()) {\n            sysId = sysUpdateSetGr.getValue('sys_id');\n        }\n    }\n\n    if (sysId) {\n        var us = new GlideUpdateSet();\n        us.set(sysId);\n        response.setStatus(200);\n        response.setBody({\n            message: 'Success'\n        });\n    } else {\n        response.setStatus(404);\n        response.setBody({\n            error: 'Update Set not found'\n        });\n    }\n\n\treturn response;\n\n})(request, response);"
    },
    {
      "sys_id": "d811bb8d331ba6107b18bc534d5c7bd1",
      "name": "Current Update Set",
      "http_method": "GET",
      "relative_path": "/currentUpdateSet",
      "wsd": "b8a9db8d33d7a6107b18bc534d5c7b7b",
      "script": "(function process( /*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {\n    /* dovetail_user gate (injected by bootstrap) */\n    if (!gs.hasRole('dovetail_user') && !gs.hasRole('admin')) { response.setStatus(403); response.setBody({ error: 'dovetail_user role required' }); return response; }\n\n    let {\n        scope\n    } = request.queryParams;\n\n    // Handle array parameter\n    if (scope && typeof scope !== \"string\") {\n        scope = scope[0];\n    }\n\n    let newScopeId = '';\n    let currentScopeId = '';\n\n    // Get current scope ID\n    var session = gs.getSession();\n    if (session) {\n        // currentScopeId = session.getCurrentApplicationId();\n    }\n\n    // If scope parameter provided, switch to it temporarily\n    if (scope) {\n        var sysScopeGr = new GlideRecord('sys_scope');\n        sysScopeGr.addQuery('scope', scope);\n        sysScopeGr.query();\n\n        if (sysScopeGr.next()) {\n            newScopeId = sysScopeGr.getUniqueValue();\n            gs.setCurrentApplicationId(newScopeId);\n        }\n    }\n\n    // Get current update set\n    var us = new GlideUpdateSet();\n    const currentUpdateSetSysId = us.get();\n\n    if (currentUpdateSetSysId) {\n        const sysUpdateSetGr = new GlideRecord('sys_update_set');\n        if (sysUpdateSetGr.get(currentUpdateSetSysId)) {\n            response.setBody({\n                message: 'Success',\n                sysId: currentUpdateSetSysId,\n                name: sysUpdateSetGr.getDisplayValue()\n            });\n            response.setStatus(200);\n        } else {\n            response.setStatus(404);\n            response.setBody({\n                error: 'Update set record not found'\n            });\n        }\n    } else {\n        response.setStatus(404);\n        response.setBody({\n            error: 'No current update set found'\n        });\n    }\n\n    // Restore original scope if we switched\n    if (newScopeId && currentScopeId) {\n        gs.setCurrentApplicationId(currentScopeId);\n    }\n\n    return response;\n\n})(request, response);"
    },
    {
      "sys_id": "d8215358c3044710d4ddf1db05013187",
      "name": "Dovetail - Create Record",
      "http_method": "POST",
      "relative_path": "/createRecord",
      "wsd": "b8a9db8d33d7a6107b18bc534d5c7b7b",
      "script": "(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {\n    /* dovetail_user gate (injected by bootstrap) */\n    if (!gs.hasRole('dovetail_user') && !gs.hasRole('admin')) { response.setStatus(403); response.setBody({ error: 'dovetail_user role required' }); return response; }\n\r\n    var body = request.body.data;\r\n    var table = body.table;\r\n    var fields = body.fields;\r\n    var sysId = body.sys_id || \"\";\r\n    var scopeName = body.scope || \"\";\r\n    var updateSetSysId = body.update_set_sys_id || \"\";\r\n\r\n    if (!table || !fields) {\r\n        response.setStatus(400);\r\n        response.setBody({\r\n            error: \"Missing required fields: table, fields\",\r\n        });\r\n        return response;\r\n    }\r\n\r\n    try {\r\n        // Save and switch update set if provided\r\n        var us = new GlideUpdateSet();\r\n        var previousUpdateSet = \"\";\r\n        if (updateSetSysId) {\r\n            previousUpdateSet = us.get();\r\n            us.set(updateSetSysId);\r\n        }\r\n\r\n        var gr = new GlideRecord(table);\r\n        gr.initialize();\r\n        gr.newRecord();\r\n\r\n        // Set specific sys_id if provided (for cross-instance moves)\r\n        if (sysId) {\r\n            gr.setNewGuidValue(sysId);\r\n        }\r\n\r\n        // Set scope if provided\r\n        if (scopeName) {\r\n            var scopeGR = new GlideRecord(\"sys_scope\");\r\n            scopeGR.addQuery(\"scope\", scopeName);\r\n            scopeGR.query();\r\n            if (scopeGR.next()) {\r\n                gr.setValue(\"sys_scope\", scopeGR.getUniqueValue());\r\n            }\r\n        }\r\n\r\n        // Set field values\r\n        for (var field in fields) {\r\n            if (fields.hasOwnProperty(field)) {\r\n                gr.setValue(field, fields[field]);\r\n            }\r\n        }\r\n\r\n        var newSysId = gr.insert();\r\n\r\n        // Restore previous update set\r\n        if (updateSetSysId && previousUpdateSet) {\r\n            us.set(previousUpdateSet);\r\n        }\r\n\r\n        if (!newSysId) {\r\n            response.setStatus(500);\r\n            response.setBody({\r\n                error: \"Failed to insert record. Check table permissions and field values.\",\r\n            });\r\n            return response;\r\n        }\r\n\r\n        response.setStatus(201);\r\n        response.setBody({\r\n            success: true,\r\n            sys_id: newSysId.toString(),\r\n            table: table,\r\n            name: gr.getDisplayValue() || gr.getValue(\"name\") || \"\",\r\n            update_set: updateSetSysId || \"\",\r\n        });\r\n    } catch (e) {\r\n        // Restore update set on error\r\n        if (updateSetSysId && previousUpdateSet) {\r\n            try { us.set(previousUpdateSet); } catch (ignore) {}\r\n        }\r\n        response.setStatus(500);\r\n        response.setBody({\r\n            error: \"Server error: \" + e.message,\r\n        });\r\n    }\r\n\r\n    return response;\r\n})(request, response);\r\n"
    },
    {
      "sys_id": "1f99d71cc3444710d4ddf1db05013192",
      "name": "Dovetail - Delete Record",
      "http_method": "POST",
      "relative_path": "/deleteRecord",
      "wsd": "b8a9db8d33d7a6107b18bc534d5c7b7b",
      "script": "(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {\n    /* dovetail_user gate (injected by bootstrap) */\n    if (!gs.hasRole('dovetail_user') && !gs.hasRole('admin')) { response.setStatus(403); response.setBody({ error: 'dovetail_user role required' }); return response; }\n\r\n    var body = request.body.data;\r\n    var table = body.table;\r\n    var sysId = body.sys_id;\r\n\r\n    if (!table || !sysId) {\r\n        response.setStatus(400);\r\n        response.setBody({ error: \"Missing required fields: table, sys_id\" });\r\n        return response;\r\n    }\r\n\r\n    try {\r\n        var gr = new GlideRecord(table);\r\n        if (!gr.get(sysId)) {\r\n            response.setStatus(404);\r\n            response.setBody({ error: \"Record not found: \" + table + \"/\" + sysId });\r\n            return response;\r\n        }\r\n\r\n        var name = gr.getDisplayValue() || gr.getValue(\"name\") || \"\";\r\n\r\n        if (!gr.deleteRecord()) {\r\n            response.setStatus(500);\r\n            response.setBody({ error: \"Failed to delete record\" });\r\n            return response;\r\n        }\r\n\r\n        response.setStatus(200);\r\n        response.setBody({\r\n            success: true,\r\n            sys_id: sysId,\r\n            table: table,\r\n            name: name\r\n        });\r\n    } catch (e) {\r\n        response.setStatus(500);\r\n        response.setBody({ error: \"Server error: \" + e.message });\r\n    }\r\n\r\n    return response;\r\n})(request, response);\r\n"
    },
    {
      "sys_id": "8570ee0cc3cc0310d4ddf1db05013106",
      "name": "Push with Update Set",
      "http_method": "POST",
      "relative_path": "/pushWithUpdateSet",
      "wsd": "b8a9db8d33d7a6107b18bc534d5c7b7b",
      "script": "(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {\n    /* dovetail_user gate (injected by bootstrap) */\n    if (!gs.hasRole('dovetail_user') && !gs.hasRole('admin')) { response.setStatus(403); response.setBody({ error: 'dovetail_user role required' }); return response; }\n\n\tvar body = request.body.data;\n\tvar updateSetSysId = body.update_set_sys_id;\n\tvar table = body.table;\n\tvar recordSysId = body.record_sys_id;\n\tvar fields = body.fields;\n\n\tif (!updateSetSysId || !table || !recordSysId || !fields) {\n\t\tresponse.setStatus(400);\n\t\tresponse.setBody({\n\t\t\terror: \"Missing required fields: update_set_sys_id, table, record_sys_id, fields\",\n\t\t});\n\t\treturn response;\n\t}\n\n\ttry {\n\t\t// Save and switch update set for this transaction\n\t\tvar us = new GlideUpdateSet();\n\t\tvar previousUpdateSet = us.get();\n\t\tus.set(updateSetSysId);\n\n\t\t// Update the record\n\t\tvar gr = new GlideRecord(table);\n\t\tif (gr.get(recordSysId)) {\n\t\t\tfor (var field in fields) {\n\t\t\t\tif (fields.hasOwnProperty(field)) {\n\t\t\t\t\tgr.setValue(field, fields[field]);\n\t\t\t\t}\n\t\t\t}\n\t\t\tgr.update();\n\n\t\t\t// Restore previous update set\n\t\t\tus.set(previousUpdateSet);\n\n\t\t\tresponse.setStatus(200);\n\t\t\tresponse.setBody({\n\t\t\t\tsuccess: true,\n\t\t\t\tmessage: \"Record updated in update set\",\n\t\t\t\ttable: table,\n\t\t\t\tsys_id: recordSysId,\n\t\t\t\tupdate_set: updateSetSysId,\n\t\t\t});\n\t\t} else {\n\t\t\tus.set(previousUpdateSet);\n\t\t\tresponse.setStatus(404);\n\t\t\tresponse.setBody({\n\t\t\t\terror: \"Record not found: \" + table + \"/\" + recordSysId,\n\t\t\t});\n\t\t}\n\t} catch (e) {\n\t\tresponse.setStatus(500);\n\t\tresponse.setBody({\n\t\t\terror: \"Server error: \" + e.message,\n\t\t});\n\t}\n\n\treturn response;\n})(request, response);\n"
    },
    {
      "sys_id": "e5ca236c334887107b18bc534d5c7b75",
      "name": "Bulk Download",
      "http_method": "POST",
      "relative_path": "/bulkDownload",
      "wsd": "afaa2facc30cc710d4ddf1db050131b0",
      "script": "/**\n * POST /api/sinc/sincronia/bulkDownload\n * Downloads file contents for specific missing records.\n * Body: { missingFiles, tableOptions }\n *\n * Web Service Definition: afaa2facc30cc710d4ddf1db050131b0 (Sincronia, global)\n * Operation sys_id: e5ca236c334887107b18bc534d5c7b75\n */\n(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {\n    /* dovetail_user gate (injected by bootstrap) */\n    if (!gs.hasRole('dovetail_user') && !gs.hasRole('admin')) { response.setStatus(403); response.setBody({ error: 'dovetail_user role required' }); return response; }\n\n  var utils = new SincUtils();\n  var data = request.body.data;\n  var missingFiles = data.missingFiles;\n  var tableOptions = data.tableOptions;\n\n  var result = utils.processMissingFiles(missingFiles, tableOptions);\n  response.setBody(result);\n})(request, response);\n"
    },
    {
      "sys_id": "6bbaefacc30cc710d4ddf1db050131ac",
      "name": "Get App List",
      "http_method": "GET",
      "relative_path": "/getAppList",
      "wsd": "afaa2facc30cc710d4ddf1db050131b0",
      "script": "/**\n * GET /api/sinc/sincronia/getAppList\n * Returns list of all application scopes.\n *\n * Web Service Definition: afaa2facc30cc710d4ddf1db050131b0 (Sincronia, global)\n * Operation sys_id: 6bbaefacc30cc710d4ddf1db050131ac\n */\n(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {\n    /* dovetail_user gate (injected by bootstrap) */\n    if (!gs.hasRole('dovetail_user') && !gs.hasRole('admin')) { response.setStatus(403); response.setBody({ error: 'dovetail_user role required' }); return response; }\n\n  var utils = new SincUtils();\n  response.setBody(utils.getAppList());\n})(request, response);\n"
    },
    {
      "sys_id": "98ca23ecc30cc710d4ddf1db05013120",
      "name": "Get Current Scope",
      "http_method": "GET",
      "relative_path": "/getCurrentScope",
      "wsd": "afaa2facc30cc710d4ddf1db050131b0",
      "script": "/**\n * GET /api/sinc/sincronia/getCurrentScope\n * Returns current user's active application scope.\n *\n * Web Service Definition: afaa2facc30cc710d4ddf1db050131b0 (Sincronia, global)\n * Operation sys_id: 98ca23ecc30cc710d4ddf1db05013120\n */\n(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {\n    /* dovetail_user gate (injected by bootstrap) */\n    if (!gs.hasRole('dovetail_user') && !gs.hasRole('admin')) { response.setStatus(403); response.setBody({ error: 'dovetail_user role required' }); return response; }\n\n  var utils = new SincUtils();\n  response.setBody(utils.getCurrentScope());\n})(request, response);\n"
    },
    {
      "sys_id": "78ca23ecc30cc710d4ddf1db050131c6",
      "name": "Get Manifest",
      "http_method": "POST",
      "relative_path": "/getManifest/{scope}",
      "wsd": "afaa2facc30cc710d4ddf1db050131b0",
      "script": "/**\n * POST /api/sinc/sincronia/getManifest/{scope}\n * Returns full manifest of records and optionally file contents for a scope.\n * Path param: scope (application scope name)\n * Body: { includes, excludes, tableOptions, withFiles, getContents }\n *\n * Web Service Definition: afaa2facc30cc710d4ddf1db050131b0 (Sincronia, global)\n * Operation sys_id: 78ca23ecc30cc710d4ddf1db050131c6\n */\n(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {\n    /* dovetail_user gate (injected by bootstrap) */\n    if (!gs.hasRole('dovetail_user') && !gs.hasRole('admin')) { response.setStatus(403); response.setBody({ error: 'dovetail_user role required' }); return response; }\n\n  var utils = new SincUtils();\n  var data = request.body.data;\n  var includes = data.includes;\n  var excludes = data.excludes;\n  var tableOptions = data.tableOptions || {};\n  var getContents = data.getContents || data.withFiles || false;\n  var scopeName = request.pathParams.scope;\n\n  var result = utils.getManifest({\n    scopeName: scopeName,\n    includes: includes,\n    excludes: excludes,\n    tableOptions: tableOptions,\n    getContents: getContents\n  });\n\n  response.setBody(result);\n})(request, response);\n"
    },
    {
      "sys_id": "deca2fe8334887107b18bc534d5c7be3",
      "name": "Push ATF File",
      "http_method": "POST",
      "relative_path": "/pushATFfile",
      "wsd": "afaa2facc30cc710d4ddf1db050131b0",
      "script": "/**\n * POST /api/sinc/sincronia/pushATFfile\n * Updates an ATF step record's inputs.script field.\n * Body: { file, sys_id }\n *\n * Web Service Definition: afaa2facc30cc710d4ddf1db050131b0 (Sincronia, global)\n * Operation sys_id: deca2fe8334887107b18bc534d5c7be3\n */\n(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {\n    /* dovetail_user gate (injected by bootstrap) */\n    if (!gs.hasRole('dovetail_user') && !gs.hasRole('admin')) { response.setStatus(403); response.setBody({ error: 'dovetail_user role required' }); return response; }\n\n  var file = request.body.data.file;\n  var sys_id = request.body.data.sys_id;\n\n  if (new SincUtils().pushATFfile(sys_id, file)) {\n    response.setBody(\"success\");\n  } else {\n    response.setError(new sn_ws_err.BadRequestError(\"Error updating ATF record\"));\n  }\n})(request, response);\n"
    }
  ]
};

  // ---- Guardrail 1: must run in the Dovetail application scope ----
  var curApp = gs.getCurrentApplicationId();
  if (curApp !== D.app) {
    gs.error("[dovetail-bootstrap] ABORT - not in the Dovetail scope. current=" + curApp +
             ". Open the Dovetail app in Studio and run this as a Fix Script.");
    return;
  }

  // ---- Guardrail 2: an explicit update set must be active ----
  var curUs = gs.getPreference("sys_update_set");
  if (!curUs) { gs.error("[dovetail-bootstrap] ABORT - no active update set."); return; }
  var usGr = new GlideRecord("sys_update_set");
  if (!usGr.get(curUs)) { gs.error("[dovetail-bootstrap] ABORT - current update set not found: " + curUs); return; }
  if (usGr.getValue("name") === "Default" || usGr.getValue("state") !== "in progress") {
    gs.error("[dovetail-bootstrap] ABORT - refuse to write into '" + usGr.getValue("name") +
             "'. Create a dedicated in-progress update set while in the Dovetail app first.");
    return;
  }
  var usApp = usGr.getValue("application");
  if (usApp !== D.app) {
    gs.warn("[dovetail-bootstrap] WARNING - update set application=" + usApp +
            " (expected " + D.app + "). Proceeding; verify the set is Dovetail-scoped.");
  }
  gs.info("[dovetail-bootstrap] scope OK, update set '" + usGr.getValue("name") + "' active. Starting.");

  function upsert(table, sysId, fields, label) {
    var gr = new GlideRecord(table);
    var verb;
    if (gr.get(sysId)) { verb = "updated"; }
    else { gr.initialize(); gr.setNewGuidValue(sysId); verb = "inserted"; }
    for (var k in fields) gr.setValue(k, fields[k]);
    var ok = (verb === "updated") ? gr.update() : gr.insert();
    gs.info("[dovetail-bootstrap]   " + verb + " " + table + " :: " + label + (ok ? "" : "  <FAILED>"));
    return ok;
  }

  // ---- 1. dovetail_user role (create if missing) ----
  upsert("sys_user_role", D.role_sys_id, { name: "dovetail_user", description: "Dovetail Scripted REST API access" }, "dovetail_user");

  // ---- 2. script includes ----
  D.sis.forEach(function(si) {
    upsert("sys_script_include", si.sys_id,
      { name: si.name, api_name: si.api_name, active: "true", access: "public", script: si.script }, si.name);
  });

  // ---- 3. web service definitions (paths preserved; ACL off, role enforced in-script) ----
  D.wsds.forEach(function(w) {
    upsert("sys_ws_definition", w.sys_id,
      { name: w.name, namespace: w.namespace, service_id: w.service_id, base_uri: w.base_uri,
        active: "true", enforce_acl: "false" }, w.name + " (" + w.base_uri + ")");
  });

  // ---- 4. operations (dovetail_user gate injected; snc_internal_role requirement removed) ----
  D.ops.forEach(function(o) {
    upsert("sys_ws_operation", o.sys_id,
      { name: o.name, web_service_definition: o.wsd, http_method: o.http_method,
        relative_path: o.relative_path, operation_script: o.script, active: "true",
        requires_authentication: "true", requires_acl_authorization: "false",
        requires_snc_internal_role: "false" },
      o.http_method + " " + o.relative_path);
  });

  gs.info("[dovetail-bootstrap] DONE. Grant 'dovetail_user' to the integration user, then: " +
          "curl -u USER:PASS https://<instance>/api/cadso/dovetail/currentUpdateSet");
})();
