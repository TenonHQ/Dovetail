/**
 * Dovetail init plugin for @tenonhq/dovetail-servicenow.
 * Auth piggybacks on `npx dove configure` — SN_INSTANCE / SN_USER / SN_PASSWORD
 * already get wired there, so this plugin is currently a no-op discoverable marker.
 */

export const sincPlugin = {
  name: "servicenow",
  displayName: "ServiceNow",
  description: "Dictionary / choice helpers and update-set-aware writes",
  login: [],
  configure: []
};
