import { validatePromotionLadder } from "../config";
import type { PromotionLadder } from "../types";

function validLadder(): PromotionLadder {
  return {
    taskIdPattern: "(DEV-[a-z0-9]+)",
    instances: {
      studio: {
        url: "tenonworkstudio",
        environment: "servicenow-studio",
        enabled: true,
        role: "dev-authoring",
      },
      yard: {
        url: "tenonworkyard",
        environment: "servicenow-yard",
        enabled: true,
      },
      qa: {
        url: null,
        environment: "servicenow-qa",
        enabled: false,
        todo: "provision Demo 7",
      },
    },
    statusMap: {
      "push to yard": {
        clickupStatusId: "s1",
        sourceInstance: "studio",
        targetInstance: "yard",
        transport: "sawmill",
        enabled: true,
      },
      "pull to demo 7": {
        clickupStatusId: "s2",
        sourceInstance: "yard",
        targetInstance: "qa",
        transport: "sawmill",
        enabled: false,
      },
    },
    skipPreviewErrors: [],
  };
}

describe("validatePromotionLadder", function () {
  it("accepts a valid ladder", function () {
    expect(validatePromotionLadder({ config: validLadder() })).toEqual([]);
  });

  it("flags a taskIdPattern mismatch with the branch layer", function () {
    var issues = validatePromotionLadder({
      config: validLadder(),
      branchTaskIdPattern: "(US-[a-z0-9]+)",
    });
    expect(
      issues.some(function (i) {
        return i.path === "taskIdPattern";
      }),
    ).toBe(true);
  });

  it("flags an enabled rung that points at a disabled / url-less instance", function () {
    var ladder = validLadder();
    ladder.statusMap["pull to demo 7"].enabled = true;
    var issues = validatePromotionLadder({ config: ladder });
    expect(
      issues.some(function (i) {
        return i.path === "statusMap['pull to demo 7']";
      }),
    ).toBe(true);
  });

  it("flags a duplicate clickupStatusId", function () {
    var ladder = validLadder();
    ladder.statusMap["pull to demo 7"].clickupStatusId = "s1";
    var issues = validatePromotionLadder({ config: ladder });
    expect(
      issues.some(function (i) {
        return /duplicate clickupStatusId/.test(i.message);
      }),
    ).toBe(true);
  });

  it("flags a bad transport and an unknown instance reference (untrusted JSON)", function () {
    var bad = {
      taskIdPattern: "(DEV-[a-z0-9]+)",
      instances: { studio: { url: "x", environment: "e", enabled: true } },
      statusMap: {
        "push to yard": {
          clickupStatusId: "s1",
          sourceInstance: "nowhere",
          targetInstance: "studio",
          transport: "carrier-pigeon",
          enabled: false,
        },
      },
    };
    var issues = validatePromotionLadder({ config: bad });
    expect(
      issues.some(function (i) {
        return /transport must be one of/.test(i.message);
      }),
    ).toBe(true);
    expect(
      issues.some(function (i) {
        return /sourceInstance is not defined/.test(i.message);
      }),
    ).toBe(true);
  });

  it("rejects a non-object", function () {
    expect(validatePromotionLadder({ config: null })[0].path).toBe("promotion");
  });

  it("accepts a dynamic-source rung with the dev-instance config", function () {
    var ladder = validLadder();
    ladder.devInstanceFieldId = "field-id";
    ladder.devInstanceHostPattern = "^tenonwork[a-z0-9-]+$";
    ladder.statusMap["push to yard"] = {
      clickupStatusId: "s1",
      sourceFrom: "devInstance",
      targetInstance: "yard",
      transport: "sawmill",
      enabled: true,
    };
    expect(validatePromotionLadder({ config: ladder })).toEqual([]);
  });

  it("flags a dynamic-source rung missing the field id + host pattern", function () {
    var ladder = validLadder();
    ladder.statusMap["push to yard"] = {
      clickupStatusId: "s1",
      sourceFrom: "devInstance",
      targetInstance: "yard",
      transport: "sawmill",
      enabled: true,
    };
    var issues = validatePromotionLadder({ config: ladder });
    expect(
      issues.some(function (i) {
        return i.path === "devInstanceFieldId";
      }),
    ).toBe(true);
    expect(
      issues.some(function (i) {
        return i.path === "devInstanceHostPattern";
      }),
    ).toBe(true);
  });

  it("flags a rung that sets both sourceInstance and sourceFrom", function () {
    // Both-set is un-constructable under the XOR type — validate as untrusted JSON.
    var bad = {
      taskIdPattern: "(DEV-[a-z0-9]+)",
      devInstanceFieldId: "field-id",
      devInstanceHostPattern: "^tenonwork[a-z0-9-]+$",
      instances: {
        yard: { url: "tenonworkyard", environment: "e", enabled: true },
      },
      statusMap: {
        "push to yard": {
          clickupStatusId: "s1",
          sourceInstance: "yard",
          sourceFrom: "devInstance",
          targetInstance: "yard",
          transport: "sawmill",
          enabled: true,
        },
      },
    };
    var issues = validatePromotionLadder({ config: bad });
    expect(
      issues.some(function (i) {
        return /exactly one of sourceInstance or sourceFrom/.test(i.message);
      }),
    ).toBe(true);
  });

  it("flags an invalid sourceFrom value", function () {
    var bad = {
      taskIdPattern: "(DEV-[a-z0-9]+)",
      instances: { studio: { url: "x", environment: "e", enabled: true } },
      statusMap: {
        "push to yard": {
          clickupStatusId: "s1",
          sourceFrom: "somethingElse",
          targetInstance: "studio",
          transport: "sawmill",
          enabled: false,
        },
      },
    };
    var issues = validatePromotionLadder({ config: bad });
    expect(
      issues.some(function (i) {
        return /sourceFrom must be 'devInstance'/.test(i.message);
      }),
    ).toBe(true);
  });

  it("flags a rung that sets neither sourceInstance nor sourceFrom", function () {
    var bad = {
      taskIdPattern: "(DEV-[a-z0-9]+)",
      instances: { studio: { url: "x", environment: "e", enabled: true } },
      statusMap: {
        "push to yard": {
          clickupStatusId: "s1",
          targetInstance: "studio",
          transport: "sawmill",
          enabled: false,
        },
      },
    };
    var issues = validatePromotionLadder({ config: bad });
    expect(
      issues.some(function (i) {
        return /either sourceInstance or sourceFrom/.test(i.message);
      }),
    ).toBe(true);
  });

  it("flags a non-boolean enabled (a stringy 'true' would silently disable the rung)", function () {
    var bad = {
      taskIdPattern: "(DEV-[a-z0-9]+)",
      instances: { studio: { url: "x", environment: "e", enabled: true } },
      statusMap: {
        "push to yard": {
          clickupStatusId: "s1",
          sourceInstance: "studio",
          targetInstance: "studio",
          transport: "sawmill",
          enabled: "true",
        },
      },
    };
    var issues = validatePromotionLadder({ config: bad });
    expect(
      issues.some(function (i) {
        return i.path === "statusMap['push to yard'].enabled";
      }),
    ).toBe(true);
  });
});
