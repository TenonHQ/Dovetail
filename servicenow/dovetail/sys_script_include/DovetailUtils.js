/**
 * DovetailUtils — entry-point class used by the Dovetail REST API operations.
 * Extends DovetailUtilsMS so individual operation scripts can `new DovetailUtils()` and
 * call helpers like getManifest, processMissingFiles, getAppList, etc.
 *
 * Deploy to: Global Scope > Script Includes
 * Name: DovetailUtils
 * api_name: global.DovetailUtils
 * sys_id differs per instance — look it up by name, never hardcode.
 * Accessible from: All application scopes
 */
var DovetailUtils = Class.create();
DovetailUtils.prototype = Object.extendsObject(DovetailUtilsMS, {
  initialize: function () {
    DovetailUtilsMS.prototype.initialize.call(this);
    this.type = "DovetailUtils";
  },

  type: "DovetailUtils"
});
