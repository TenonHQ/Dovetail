/**
 * True when a scope argument is a sys_scope sys_id (32 lowercase hex) rather than a
 * scope name. A sys_id is passed to the server as-is instead of a name lookup — the only
 * way to target a specific global-scope app, since every global app's scope name is
 * "global".
 */
export const isScopeSysId = (value: string): boolean => /^[0-9a-f]{32}$/.test(value);
