var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
(function (factory) {
    if (typeof module === "object" && typeof module.exports === "object") {
        var v = factory(require, exports);
        if (v !== undefined) module.exports = v;
    }
    else if (typeof define === "function" && define.amd) {
        define(["require", "exports", "axios", "chalk"], factory);
    }
})(function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.fetchSchema = fetchSchema;
    const axios_1 = __importDefault(require("axios"));
    const chalk_1 = __importDefault(require("chalk"));
    function createClient(options) {
        const baseURL = options.instance.startsWith("https://")
            ? options.instance
            : `https://${options.instance}`;
        // An inbound API key is the default auth mode when present: the
        // x-sn-apikey header replaces basic auth entirely.
        const headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        };
        if (options.apiKey) {
            headers["x-sn-apikey"] = options.apiKey;
        }
        return axios_1.default.create({
            baseURL: baseURL.endsWith("/") ? baseURL : baseURL + "/",
            auth: options.apiKey
                ? undefined
                : {
                    username: options.username,
                    password: options.password,
                },
            headers,
        });
    }
    async function getTablesForScope(options) {
        const { client, scope } = options;
        const response = await client.get("api/now/table/sys_db_object", {
            params: {
                sysparm_query: `nameSTARTSWITH${scope}_`,
                sysparm_fields: "name,label,super_class",
            },
        });
        return response.data.result || [];
    }
    async function getTableHierarchy(options) {
        const { client, tableName } = options;
        const visited = options.visited || new Set();
        if (visited.has(tableName)) {
            return [];
        }
        visited.add(tableName);
        try {
            const response = await client.get("api/now/table/sys_db_object", {
                params: {
                    sysparm_query: `name=${tableName}`,
                    sysparm_fields: "name,super_class,label",
                },
            });
            if (response.data.result && response.data.result.length > 0) {
                const table = response.data.result[0];
                const hierarchy = [tableName];
                if (table.super_class && table.super_class.value) {
                    const parentResponse = await client.get(`api/now/table/sys_db_object/${table.super_class.value}`, {
                        params: { sysparm_fields: "name" },
                    });
                    if (parentResponse.data.result && parentResponse.data.result.name) {
                        const parentHierarchy = await getTableHierarchy({
                            client,
                            tableName: parentResponse.data.result.name,
                            visited,
                        });
                        hierarchy.push(...parentHierarchy);
                    }
                }
                return hierarchy;
            }
        }
        catch (error) {
            console.error(chalk_1.default.yellow(`  Warning: Error getting hierarchy for ${tableName}: ${error.message}`));
        }
        return [tableName];
    }
    async function getTableFields(options) {
        const { client, tableName } = options;
        try {
            const query = `internal_type!=collection^ORinternal_type=NULL^name=${tableName}`;
            const response = await client.get("api/now/table/sys_dictionary", {
                params: {
                    sysparm_query: query,
                    sysparm_fields: "element,column_label,internal_type,max_length,mandatory,reference,default_value",
                },
            });
            if (response.data.result) {
                return response.data.result.map((field) => ({
                    name: field.element,
                    label: field.column_label,
                    type: field.internal_type && field.internal_type.value
                        ? field.internal_type.value
                        : field.internal_type || "",
                    max_length: field.max_length || "",
                    mandatory: field.mandatory === "true",
                    reference: field.reference || "",
                    default_value: field.default_value || "",
                    inherited_from: null,
                }));
            }
        }
        catch (error) {
            console.error(chalk_1.default.yellow(`  Warning: Error getting fields for ${tableName}: ${error.message}`));
        }
        return [];
    }
    async function fetchSchema(options) {
        const { scopes } = options;
        const client = createClient({
            instance: options.instance,
            username: options.username,
            password: options.password,
            apiKey: options.apiKey,
        });
        console.log(chalk_1.default.blue(`Fetching table schemas for ${scopes.length} scopes...\n`));
        const schema = {};
        for (const scope of scopes) {
            console.log(chalk_1.default.blue(`\nScope: ${scope}`));
            const tables = await getTablesForScope({ client, scope });
            if (tables.length === 0) {
                console.log(chalk_1.default.yellow(`  No tables found for scope ${scope}`));
                continue;
            }
            console.log(chalk_1.default.green(`  Found ${tables.length} tables`));
            for (const table of tables) {
                console.log(`  Processing: ${chalk_1.default.cyan(table.name)} (${table.label})`);
                const hierarchy = await getTableHierarchy({ client, tableName: table.name });
                console.log(chalk_1.default.gray(`    Hierarchy: ${hierarchy.join(" -> ")}`));
                const allFields = new Map();
                for (let i = hierarchy.length - 1; i >= 0; i--) {
                    const hierarchyTableName = hierarchy[i];
                    const fields = await getTableFields({ client, tableName: hierarchyTableName });
                    for (const field of fields) {
                        allFields.set(field.name, {
                            ...field,
                            inherited_from: i > 0 ? hierarchyTableName : null,
                        });
                    }
                }
                schema[table.name] = {
                    label: table.label,
                    scope,
                    parent: hierarchy.length > 1 ? hierarchy[1] : null,
                    hierarchy,
                    fields: Array.from(allFields.values()),
                };
                console.log(chalk_1.default.gray(`    ${allFields.size} fields (including inherited)`));
            }
        }
        console.log(chalk_1.default.green(`\nFetched schema for ${Object.keys(schema).length} tables across ${scopes.length} scopes`));
        return schema;
    }
});
