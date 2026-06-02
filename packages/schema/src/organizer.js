var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
(function (factory) {
    if (typeof module === "object" && typeof module.exports === "object") {
        var v = factory(require, exports);
        if (v !== undefined) module.exports = v;
    }
    else if (typeof define === "function" && define.amd) {
        define(["require", "exports", "fs", "path", "chalk"], factory);
    }
})(function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.groupByApplication = groupByApplication;
    exports.organizeSchema = organizeSchema;
    const fs_1 = require("fs");
    const path_1 = __importDefault(require("path"));
    const chalk_1 = __importDefault(require("chalk"));
    function getAppName(scope) {
        // Extract the app short name from the scope identifier.
        // Pattern: x_{vendor}_{app} -> {app}
        // Examples:
        //   x_cadso_work     -> work
        //   x_cadso_ti_agile -> ti_agile
        //   x_nuvo_sinc      -> sinc
        const parts = scope.split("_");
        // First two parts are the vendor prefix (x, vendor)
        if (parts.length > 2) {
            return parts.slice(2).join("_");
        }
        return scope;
    }
    function groupByApplication(options) {
        const { schema } = options;
        const tablesByApp = {};
        for (const [tableName, tableData] of Object.entries(schema)) {
            const appName = getAppName(tableData.scope);
            if (!tablesByApp[appName]) {
                tablesByApp[appName] = {};
            }
            tablesByApp[appName][tableName] = tableData;
        }
        return tablesByApp;
    }
    async function ensureDir(dirPath) {
        try {
            await fs_1.promises.mkdir(dirPath, { recursive: true });
        }
        catch (e) {
            if (e.code !== "EEXIST") {
                throw e;
            }
        }
    }
    async function writeTableFiles(options) {
        const { appDir, tables } = options;
        for (const [tableName, tableData] of Object.entries(tables)) {
            const enhancedData = {
                table_name: tableName,
                label: tableData.label,
                scope: tableData.scope,
                parent: tableData.parent,
                hierarchy: tableData.hierarchy,
                field_count: tableData.fields.length,
                fields: tableData.fields,
            };
            const filePath = path_1.default.join(appDir, `${tableName}.json`);
            await fs_1.promises.writeFile(filePath, JSON.stringify(enhancedData, null, 2));
        }
    }
    async function writeSummary(options) {
        const { appDir, appName, tables } = options;
        const summary = {
            application: appName,
            table_count: Object.keys(tables).length,
            tables: Object.keys(tables).map((tableName) => ({
                name: tableName,
                label: tables[tableName].label,
                field_count: tables[tableName].fields.length,
                has_parent: !!tables[tableName].parent,
            })),
        };
        const summaryPath = path_1.default.join(appDir, "_summary.json");
        await fs_1.promises.writeFile(summaryPath, JSON.stringify(summary, null, 2));
    }
    async function writeIndex(options) {
        const { outputDir, tablesByApp, instance, scopes, totalTables } = options;
        const index = {
            instance,
            total_tables: totalTables,
            scopes,
            applications: Object.keys(tablesByApp).map((appName) => ({
                name: appName,
                table_count: Object.keys(tablesByApp[appName]).length,
                tables: Object.keys(tablesByApp[appName]),
            })),
        };
        const indexPath = path_1.default.join(outputDir, "index.json");
        await fs_1.promises.writeFile(indexPath, JSON.stringify(index, null, 2));
        return index;
    }
    async function organizeSchema(options) {
        const { schema, outputDir, instance, scopes } = options;
        await ensureDir(outputDir);
        const tablesByApp = groupByApplication({ schema });
        const totalTables = Object.keys(schema).length;
        console.log(chalk_1.default.blue(`\nOrganizing ${totalTables} tables into ${Object.keys(tablesByApp).length} applications...\n`));
        for (const [appName, tables] of Object.entries(tablesByApp)) {
            const appDir = path_1.default.join(outputDir, appName);
            await ensureDir(appDir);
            await writeTableFiles({ appDir, tables });
            await writeSummary({ appDir, appName, tables });
            console.log(`  ${chalk_1.default.cyan(appName)}: ${Object.keys(tables).length} tables`);
        }
        const index = await writeIndex({
            outputDir,
            tablesByApp,
            instance,
            scopes,
            totalTables,
        });
        console.log(chalk_1.default.green(`\nSchema organized into ${outputDir}`));
        return index;
    }
});
