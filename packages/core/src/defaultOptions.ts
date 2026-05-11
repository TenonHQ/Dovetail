import { Sinc } from "@tenonhq/dovetail-types";

// INTENTIONALLY EMPTY — dove.config.js is the single source of truth.
// Legacy defaults (26 excluded tables + content_css include) were removed
// during the config-as-king overhaul. See Claude memory for the preserved list.
let excludes: Sinc.TablePropMap = {};
let includes: Sinc.TablePropMap = {};
let tableOptions: Sinc.ITableOptionsMap = {};
let scopes: Sinc.ScopedConfigsMap = {};

export { excludes, includes, scopes, tableOptions };
