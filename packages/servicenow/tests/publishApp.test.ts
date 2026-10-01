/**
 * publish-app unit tests. Fixtures under fixtures/publishApp.* are VERBATIM
 * responses from the 2026-07-16 HAR capture of the real UI publish flow
 * (credentials stripped — the capture's password never reached the repo).
 */

import * as fs from "fs";
import * as path from "path";

import {
  publishApp,
  buildStartFields,
  buildCreateUpdateSetFields,
  buildPublishToUpdateSetFields,
  resolveUpdateSetNaming,
  parsePublishTargets,
  parseXmlAnswer,
  parseProgressTree,
  classifyProgress,
  flattenSteps,
  harvestProgressResults,
  parseCicdPublishResponse,
  parseCicdProgress,
} from "../src/publishApp";
import type {
  PublishAppParams,
  ProgressNode,
  PublishTransport,
} from "../src/publishApp";
import type { FormSession, PostResult } from "../src/table";
import { makeMockClient } from "./mockClient";

var FIXTURES = path.join(__dirname, "fixtures");

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

var START_XML = fixture("publishApp.startAnswer.xml");
var RUNNING_XML = fixture("publishApp.progressRunning.xml");
var SUCCESS_XML = fixture("publishApp.progressSuccessStore.xml");
var CREATE_US_XML = fixture("publishApp.createUpdateSetAnswer.xml");
var PUBLISH_US_XML = fixture("publishApp.publishToUpdateSetAnswer.xml");
var SUCCESS_US_XML = fixture("publishApp.progressSuccessUpdateSet.xml");

/** sys_update_set sys_id the HAR's createUpdateSet call answered with. */
var US_SYS_ID = "2d368e8f87928b901e398516dabb3509";
/** Progress worker sys_id from the HAR's publishToUpdateSet call. */
var US_WORKER_SYS_ID = "7d36ce8f87928b901e398516dabb354f";

var APP_ROW = {
  sys_id: "6f609bbe8731a910b656fe66cebb3552",
  scope: "x_cadso_filter",
  name: "@tenon/list-filter",
  version: "6.0.4",
};

var STORE_PASSWORD = "test-store-password";

function appQuery() {
  return async function (table: string, query?: string) {
    if (table === "sys_app" && query === "scope=x_cadso_filter") {
      return [APP_ROW];
    }
    if (table === "sys_app" && query === "sys_id=" + APP_ROW.sys_id) {
      return [APP_ROW];
    }
    return [];
  };
}

function session(): FormSession {
  return { ck: "a".repeat(72), jar: {} };
}

function ok(body: string): PostResult {
  return { status: 200, location: "", body: body };
}

/** A transport whose post() answers from a scripted queue and records calls. */
function scriptedTransport(bodies: Array<PostResult>): {
  transport: PublishTransport;
  posts: Array<{ path: string; fields: Record<string, string> }>;
} {
  var posts: Array<{ path: string; fields: Record<string, string> }> = [];
  var i = 0;
  return {
    posts: posts,
    transport: {
      openSession: async function () {
        return session();
      },
      post: async function (_auth, _session, postPath, fields) {
        posts.push({ path: postPath, fields: fields });
        var res = bodies[Math.min(i, bodies.length - 1)];
        i += 1;
        return res;
      },
      sleep: async function () {
        return;
      },
    },
  };
}

function storeParams(overrides: Partial<PublishAppParams>): PublishAppParams {
  var base: PublishAppParams = {
    client: makeMockClient({ query: appQuery() }).client,
    app: "x_cadso_filter",
    version: "6.0.20260716",
    target: "store",
    storeUsername: "publisher@example.com",
    storePassword: STORE_PASSWORD,
    instance: "example.service-now.com",
    user: "svc",
    password: "svc-pass",
    confirm: true,
  };
  return Object.assign(base, overrides);
}

describe("buildStartFields", function () {
  var common = {
    appSysId: APP_ROW.sys_id,
    version: "6.0.20260716",
    devNotes: "",
    storeUsername: "publisher@example.com",
    storePassword: STORE_PASSWORD,
  };

  it("builds the store map with credentials and publish_to_store=true", function () {
    var fields = buildStartFields(
      Object.assign({ target: "store" as const }, common),
    );
    expect(fields.sysparm_processor).toBe("sn_appauthor.ScopedAppUploaderAJAX");
    expect(fields.sysparm_name).toBe("start");
    expect(fields.sysparm_scope).toBe("global");
    expect(fields.sysparm_publish_to_store).toBe("true");
    expect(fields.sysparm_username).toBe("publisher@example.com");
    expect(fields.sysparm_password).toBe(STORE_PASSWORD);
    expect(fields.sysparm_sys_id).toBe(APP_ROW.sys_id);
    expect(fields.sysparm_version).toBe("6.0.20260716");
    // The UI sends a single space for empty notes — mirror the HAR exactly.
    expect(fields.sysparm_dev_notes).toBe(" ");
    expect(fields.sysparm_target_upload_URL).toBe("");
    expect(fields.sysparm_is_customization).toBe("");
  });

  it("builds the repo map with NO password key at all", function () {
    var fields = buildStartFields(
      Object.assign({ target: "repo" as const }, common),
    );
    expect(fields.sysparm_publish_to_store).toBe("false");
    expect(fields.sysparm_username).toBe("");
    expect("sysparm_password" in fields).toBe(false);
  });
});

describe("parseXmlAnswer", function () {
  it("extracts the execution sys_id from a real start response", function () {
    var parsed = parseXmlAnswer(START_XML);
    expect(parsed.error).toBe("");
    expect(parsed.answer).toBe("6769c7ea878e8b101e398516dabb358a");
  });

  it("reports a missing answer attribute as an error", function () {
    var parsed = parseXmlAnswer('<xml sysparm_name="start"/>');
    expect(parsed.answer).toBe("");
    expect(parsed.error).toContain("no answer attribute");
  });

  it("reports an empty body as an error", function () {
    expect(parseXmlAnswer("").error).toContain("empty");
  });

  it("entity-decodes the answer exactly once (no double-unescape)", function () {
    // &amp;quot; must decode to the literal text &quot; — decoding it all the
    // way to a bare quote would be the js/double-escaping bug.
    var parsed = parseXmlAnswer('<xml answer="a&amp;quot;b"/>');
    expect(parsed.answer).toBe("a&quot;b");
  });
});

describe("parseProgressTree / classifyProgress / harvest", function () {
  it("parses the real success tree: state 2, steps, appLink, update set", function () {
    var answer = parseXmlAnswer(SUCCESS_XML);
    var tree = parseProgressTree(answer.answer);
    expect(tree.state).toBe("2");
    expect(classifyProgress(tree)).toEqual({ terminal: true, success: true });

    var steps = flattenSteps(tree);
    var names = steps.map(function (s) {
      return s.name;
    });
    expect(names).toContain("Packaging application");
    expect(names).toContain("Uploading application");

    var harvested = harvestProgressResults(tree);
    expect(harvested.appLink).toContain("tpp.servicenow.com");
    expect(harvested.appName).toBe("REPOAPP0002712020");
    expect(harvested.updateSetSysId).toBe("7d798bea878e8b101e398516dabb3505");
  });

  it("parses the real running tree as non-terminal", function () {
    var answer = parseXmlAnswer(RUNNING_XML);
    var tree = parseProgressTree(answer.answer);
    expect(tree.state).toBe("1");
    expect(classifyProgress(tree).terminal).toBe(false);
  });

  it("classifies 3 and 4 as terminal failures", function () {
    var failed: ProgressNode = { state: "3" };
    var cancelled: ProgressNode = { state: "4" };
    expect(classifyProgress(failed)).toEqual({
      terminal: true,
      success: false,
    });
    expect(classifyProgress(cancelled)).toEqual({
      terminal: true,
      success: false,
    });
  });

  it("throws a clear error on non-JSON answers", function () {
    expect(function () {
      parseProgressTree("this is not json");
    }).toThrow(/not valid JSON/);
  });

  it("throws a clear error on JSON that is not a progress tree", function () {
    expect(function () {
      parseProgressTree('{"foo":"bar"}');
    }).toThrow(/no state field/);
  });
});

describe("parseCicdPublishResponse / parseCicdProgress", function () {
  it("harvests the progress id", function () {
    var parsed = parseCicdPublishResponse({
      result: {
        links: {
          progress: { id: "prog123", url: "https://x/progress/prog123" },
        },
        status_label: "Pending",
      },
    });
    expect(parsed.progressId).toBe("prog123");
    expect(parsed.error).toBe("");
  });

  it("reports a missing progress link", function () {
    expect(parseCicdPublishResponse({ result: {} }).error).toContain(
      "no progress id",
    );
    expect(parseCicdPublishResponse(null).error).toContain("empty");
  });

  it("parses a progress snapshot, tolerating numbers", function () {
    var progress = parseCicdProgress({
      result: {
        status: 2,
        status_label: "Successful",
        status_message: "done",
        status_detail: "",
        percent_complete: 100,
      },
    });
    expect(progress.status).toBe("2");
    expect(progress.percentComplete).toBe("100");
  });

  it("returns empty status on unknown shapes", function () {
    expect(parseCicdProgress(null).status).toBe("");
    expect(parseCicdProgress({}).status).toBe("");
  });
});

describe("publishApp — validation", function () {
  var savedUser: string | undefined;
  var savedPass: string | undefined;
  beforeEach(function () {
    savedUser = process.env.SN_STORE_USERNAME;
    savedPass = process.env.SN_STORE_PASSWORD;
    delete process.env.SN_STORE_USERNAME;
    delete process.env.SN_STORE_PASSWORD;
  });
  afterEach(function () {
    if (savedUser !== undefined) process.env.SN_STORE_USERNAME = savedUser;
    else delete process.env.SN_STORE_USERNAME;
    if (savedPass !== undefined) process.env.SN_STORE_PASSWORD = savedPass;
    else delete process.env.SN_STORE_PASSWORD;
  });

  it("requires app, version and a valid target", async function () {
    await expect(publishApp(storeParams({ app: "" }))).rejects.toThrow(
      /app .* required/,
    );
    await expect(publishApp(storeParams({ version: "" }))).rejects.toThrow(
      /version is required/,
    );
    await expect(
      publishApp(storeParams({ target: "everywhere" as unknown as "store" })),
    ).rejects.toThrow(
      /target must be 'store', 'repo', 'repo-ui', or 'update-set'/,
    );
  });

  it("refuses a NaN/non-positive timeout (would poll forever)", async function () {
    await expect(publishApp(storeParams({ timeoutMs: NaN }))).rejects.toThrow(
      /timeoutMs must be a positive number/,
    );
    await expect(publishApp(storeParams({ timeoutMs: -5 }))).rejects.toThrow(
      /timeoutMs must be a positive number/,
    );
  });

  it("refuses a live store publish without store credentials, naming the vars", async function () {
    await expect(
      publishApp(
        storeParams({ storeUsername: undefined, storePassword: undefined }),
      ),
    ).rejects.toThrow(/SN_STORE_USERNAME/);
  });

  it("errors on an unknown app selector", async function () {
    await expect(
      publishApp(storeParams({ app: "x_no_such_scope" })),
    ).rejects.toThrow(/no sys_app row matches/);
  });

  it("errors when a selector is ambiguous", async function () {
    var ctx = makeMockClient({
      query: async function () {
        return [APP_ROW, Object.assign({}, APP_ROW, { sys_id: "other" })];
      },
    });
    await expect(
      publishApp(storeParams({ client: ctx.client })),
    ).rejects.toThrow(/more than one/);
  });
});

describe("publishApp — dry-run", function () {
  it("returns a masked plan without opening a session or posting", async function () {
    var touched: Array<string> = [];
    var transport: PublishTransport = {
      openSession: async function () {
        touched.push("openSession");
        return session();
      },
      post: async function () {
        touched.push("post");
        return ok("");
      },
    };
    var result = await publishApp(
      storeParams({ dryRun: true, transport: transport }),
    );
    expect(result.status).toBe("dry-run");
    expect(touched).toEqual([]);
    expect(result.versionBefore).toBe("6.0.4");
    expect(result.appScope).toBe("x_cadso_filter");
    expect(result.note).toContain("EXTERNALLY VISIBLE");
    expect(JSON.stringify(result)).not.toContain(STORE_PASSWORD);
    var preview = result.requestPreview || {};
    expect(preview.sysparm_password).toBe("***");
  });

  it("treats a missing confirm as a dry-run (never publishes silently)", async function () {
    var result = await publishApp(storeParams({ confirm: false }));
    expect(result.status).toBe("dry-run");
  });
});

describe("publishApp — store engine", function () {
  it("publishes: start, polls through running to success, harvests results", async function () {
    var scripted = scriptedTransport([
      ok(START_XML),
      ok(RUNNING_XML),
      ok(RUNNING_XML),
      ok(SUCCESS_XML),
    ]);
    var result = await publishApp(
      storeParams({ transport: scripted.transport }),
    );
    expect(result.status).toBe("published");
    expect(result.executionSysId).toBe("6769c7ea878e8b101e398516dabb358a");
    expect(result.polls).toBe(3);
    expect(result.appLink).toContain("tpp.servicenow.com");
    expect(result.updateSetSysId).toBe("7d798bea878e8b101e398516dabb3505");
    expect(
      result.steps.map(function (s) {
        return s.name;
      }),
    ).toContain("Uploading application");

    // The start call carried the credentials; the result must never echo them.
    expect(scripted.posts[0].fields.sysparm_password).toBe(STORE_PASSWORD);
    expect(JSON.stringify(result)).not.toContain(STORE_PASSWORD);

    // Poll calls target the tracker returned by start.
    expect(scripted.posts[1].fields.sysparm_processor).toBe(
      "AJAXProgressStatusChecker",
    );
    expect(scripted.posts[1].fields.sysparm_execution_id).toBe(
      result.executionSysId,
    );
  });

  it("fails cleanly when the start call returns no execution sys_id", async function () {
    var scripted = scriptedTransport([ok('<xml answer=""/>')]);
    var result = await publishApp(
      storeParams({ transport: scripted.transport }),
    );
    expect(result.status).toBe("failed");
    expect(result.note).toContain("did not return an execution sys_id");
  });

  it("fails cleanly on a non-2xx start call", async function () {
    var scripted = scriptedTransport([
      { status: 302, location: "/welcome.do", body: "" },
    ]);
    var result = await publishApp(
      storeParams({ transport: scripted.transport }),
    );
    expect(result.status).toBe("failed");
    expect(result.note).toContain("HTTP 302");
  });

  it("times out when the tracker never terminates, keeping the tracker id", async function () {
    var scripted = scriptedTransport([ok(START_XML), ok(RUNNING_XML)]);
    var result = await publishApp(
      storeParams({ transport: scripted.transport, timeoutMs: 10 }),
    );
    expect(result.status).toBe("timeout");
    expect(result.executionSysId).toBe("6769c7ea878e8b101e398516dabb358a");
    expect(result.note).toContain("sys_execution_tracker");
  });

  it("reports a terminal failure state with the tracker's message", async function () {
    var failedTree =
      '<xml answer="{&quot;state&quot;:&quot;3&quot;,&quot;message&quot;:&quot;Version must be greater&quot;,&quot;children&quot;:[]}"/>';
    var scripted = scriptedTransport([ok(START_XML), ok(failedTree)]);
    var result = await publishApp(
      storeParams({ transport: scripted.transport }),
    );
    expect(result.status).toBe("failed");
    expect(result.note).toContain("state 3");
    expect(result.note).toContain("Version must be greater");
  });
});

describe("publishApp — repo engine (CI/CD API)", function () {
  function repoClient(
    invokeImpl: (params: {
      method: string;
      path: string;
    }) => Promise<{ status: number; body: unknown }>,
  ) {
    var ctx = makeMockClient({ query: appQuery() });
    var invokes: Array<{ method: string; path: string }> = [];
    ctx.client.now.invoke = async function (params) {
      invokes.push({ method: params.method, path: params.path });
      return invokeImpl(params);
    };
    return { client: ctx.client, invokes: invokes };
  }

  function repoParams(client: PublishAppParams["client"]): PublishAppParams {
    return {
      client: client,
      app: "x_cadso_filter",
      version: "6.0.20260716",
      target: "repo",
      confirm: true,
      transport: {
        sleep: async function () {
          return;
        },
      },
    };
  }

  it("publishes via app_repo/publish and polls the progress API", async function () {
    var progressPolls = 0;
    var fake = repoClient(async function (params) {
      if (params.path.indexOf("/api/sn_cicd/app_repo/publish") === 0) {
        return {
          status: 200,
          body: { result: { links: { progress: { id: "prog123" } } } },
        };
      }
      progressPolls += 1;
      if (progressPolls < 3) {
        return {
          status: 200,
          body: { result: { status: "1", status_label: "Running" } },
        };
      }
      return {
        status: 200,
        body: {
          result: {
            status: "2",
            status_label: "Successful",
            status_message: "Publish complete",
            percent_complete: "100",
          },
        },
      };
    });
    var result = await publishApp(repoParams(fake.client));
    expect(result.status).toBe("published");
    expect(result.executionSysId).toBe("prog123");
    expect(result.polls).toBe(3);
    expect(result.appLink).toBe("");
    expect(fake.invokes[0].method).toBe("POST");
    expect(fake.invokes[0].path).toContain("sys_id=" + APP_ROW.sys_id);
    expect(fake.invokes[0].path).toContain("version=6.0.20260716");
    expect(fake.invokes[1].path).toBe("/api/sn_cicd/progress/prog123");
  });

  it("surfaces a 403 as the sn_cicd role gap", async function () {
    var fake = repoClient(async function () {
      return { status: 403, body: {} };
    });
    var result = await publishApp(repoParams(fake.client));
    expect(result.status).toBe("failed");
    expect(result.note).toContain("sn_cicd role");
  });

  it("reports a terminal CI/CD failure with its detail", async function () {
    var fake = repoClient(async function (params) {
      if (params.path.indexOf("/api/sn_cicd/app_repo/publish") === 0) {
        return {
          status: 200,
          body: { result: { links: { progress: { id: "prog456" } } } },
        };
      }
      return {
        status: 200,
        body: {
          result: {
            status: "3",
            status_label: "Failed",
            status_detail: "Version is not greater than current version",
          },
        },
      };
    });
    var result = await publishApp(repoParams(fake.client));
    expect(result.status).toBe("failed");
    expect(result.note).toContain("Failed");
    expect(result.note).toContain("not greater");
  });

  it("needs no store credentials for the repo target", async function () {
    var savedUser = process.env.SN_STORE_USERNAME;
    var savedPass = process.env.SN_STORE_PASSWORD;
    delete process.env.SN_STORE_USERNAME;
    delete process.env.SN_STORE_PASSWORD;
    try {
      var fake = repoClient(async function (params) {
        if (params.path.indexOf("/api/sn_cicd/app_repo/publish") === 0) {
          return {
            status: 200,
            body: { result: { links: { progress: { id: "p" } } } },
          };
        }
        return { status: 200, body: { result: { status: "2" } } };
      });
      var result = await publishApp(repoParams(fake.client));
      expect(result.status).toBe("published");
    } finally {
      if (savedUser !== undefined) process.env.SN_STORE_USERNAME = savedUser;
      if (savedPass !== undefined) process.env.SN_STORE_PASSWORD = savedPass;
    }
  });
});

describe("buildCreateUpdateSetFields", function () {
  var fields = buildCreateUpdateSetFields({
    appSysId: APP_ROW.sys_id,
    updateSetName: "@tenon/list-filter",
    description: "20260729",
  });

  it("targets the AppsAjaxProcessor createUpdateSet function", function () {
    expect(fields.sysparm_processor).toBe("com.snc.apps.AppsAjaxProcessor");
    expect(fields.sysparm_function).toBe("createUpdateSet");
    expect(fields.sysparm_scope).toBe("global");
  });

  it("spells the app sys_id as sysparm_appid (NOT sysparm_sys_id)", function () {
    expect(fields.sysparm_appid).toBe(APP_ROW.sys_id);
    expect("sysparm_sys_id" in fields).toBe(false);
  });

  it("passes the name and description, and never adopts the set", function () {
    expect(fields.sysparm_name).toBe("@tenon/list-filter");
    expect(fields.sysparm_description).toBe("20260729");
    // Adopting it would leak the set into unrelated writes for the rest of
    // the session — a batch would cross-contaminate.
    expect(fields.sysparm_current).toBe("false");
  });
});

describe("buildPublishToUpdateSetFields", function () {
  var base = {
    appSysId: APP_ROW.sys_id,
    updateSetSysId: US_SYS_ID,
    version: "6.0.20260729",
    description: "20260729",
    includeData: false,
  };

  it("spells the app sys_id as sysparm_sys_id (NOT sysparm_appid)", function () {
    var fields = buildPublishToUpdateSetFields(base);
    expect(fields.sysparm_sys_id).toBe(APP_ROW.sys_id);
    expect("sysparm_appid" in fields).toBe(false);
    expect(fields.sysparm_update_set_id).toBe(US_SYS_ID);
  });

  it("sends the literal 'start' as sysparm_name, not a composed label", function () {
    // The dialog composes "<app> - <version>" but the progress viewer
    // overwrites sysparm_name with "start" before it reaches the wire.
    var fields = buildPublishToUpdateSetFields(base);
    expect(fields.sysparm_name).toBe("start");
    expect(fields.sysparm_function).toBe("publishToUpdateSet");
    expect(fields.sysparm_version).toBe("6.0.20260729");
  });

  it("defaults include_data to the empty string the HAR actually sent", function () {
    expect(buildPublishToUpdateSetFields(base).sysparm_include_data).toBe("");
    var opted = buildPublishToUpdateSetFields(
      Object.assign({}, base, { includeData: true }),
    );
    expect(opted.sysparm_include_data).toBe("true");
  });
});

describe("resolveUpdateSetNaming", function () {
  it("defaults the name to the app name (the dialog input is readonly)", function () {
    var n = resolveUpdateSetNaming({
      appName: "@tenon/list-filter",
      updateSetDescription: "20260729",
    });
    expect(n.name).toBe("@tenon/list-filter");
    expect(n.description).toBe("20260729");
  });

  it("prefers an explicit name and trims it", function () {
    var n = resolveUpdateSetNaming({
      appName: "@tenon/list-filter",
      updateSetName: "  Release - July  ",
    });
    expect(n.name).toBe("Release - July");
    expect(n.description).toBe("");
  });

  it("falls back to the app name when the override is blank", function () {
    var n = resolveUpdateSetNaming({
      appName: "@tenon/list-filter",
      updateSetName: "   ",
    });
    expect(n.name).toBe("@tenon/list-filter");
  });

  it("refuses when no name can be resolved", function () {
    expect(function () {
      resolveUpdateSetNaming({ appName: "" });
    }).toThrow(/needs an update set name/);
  });
});

describe("publishApp — repo-ui target", function () {
  it("publishes over the UI uploader with publish_to_store=false", async function () {
    var scripted = scriptedTransport([
      ok(START_XML),
      ok(RUNNING_XML),
      ok(SUCCESS_XML),
    ]);
    var result = await publishApp(
      storeParams({
        target: "repo-ui",
        transport: scripted.transport,
        storeUsername: undefined,
        storePassword: undefined,
      }),
    );
    expect(result.status).toBe("published");
    expect(result.target).toBe("repo-ui");
    expect(scripted.posts[0].path).toBe("/xmlhttp.do");
    expect(scripted.posts[0].fields.sysparm_processor).toBe(
      "sn_appauthor.ScopedAppUploaderAJAX",
    );
    expect(scripted.posts[0].fields.sysparm_publish_to_store).toBe("false");
    expect(result.note).toContain("company application repository");
  });

  it("needs no Store credentials at all", async function () {
    var savedUser = process.env.SN_STORE_USERNAME;
    var savedPass = process.env.SN_STORE_PASSWORD;
    delete process.env.SN_STORE_USERNAME;
    delete process.env.SN_STORE_PASSWORD;
    try {
      var scripted = scriptedTransport([ok(START_XML), ok(SUCCESS_XML)]);
      var result = await publishApp(
        storeParams({
          target: "repo-ui",
          transport: scripted.transport,
          storeUsername: undefined,
          storePassword: undefined,
        }),
      );
      expect(result.status).toBe("published");
      // Belt and braces: no credential key may ride the request.
      expect("sysparm_password" in scripted.posts[0].fields).toBe(false);
      expect(scripted.posts[0].fields.sysparm_username).toBe("");
    } finally {
      if (savedUser !== undefined) process.env.SN_STORE_USERNAME = savedUser;
      if (savedPass !== undefined) process.env.SN_STORE_PASSWORD = savedPass;
    }
  });
});

describe("publishApp — update-set target", function () {
  function usParams(overrides: Partial<PublishAppParams>) {
    return storeParams(
      Object.assign(
        {
          target: "update-set" as const,
          version: "6.0.20260729",
          updateSetDescription: "20260729",
          storeUsername: undefined,
          storePassword: undefined,
        },
        overrides,
      ),
    );
  }

  it("creates the set then publishes into it, and polls to success", async function () {
    var scripted = scriptedTransport([
      ok(CREATE_US_XML),
      ok(PUBLISH_US_XML),
      ok(SUCCESS_US_XML),
    ]);
    var result = await publishApp(usParams({ transport: scripted.transport }));

    expect(result.status).toBe("published");
    expect(result.updateSetSysId).toBe(US_SYS_ID);
    expect(result.executionSysId).toBe(US_WORKER_SYS_ID);

    // Call 1 — createUpdateSet, named after the app, described by the stamp.
    expect(scripted.posts[0].fields.sysparm_function).toBe("createUpdateSet");
    expect(scripted.posts[0].fields.sysparm_name).toBe(APP_ROW.name);
    expect(scripted.posts[0].fields.sysparm_description).toBe("20260729");

    // Call 2 — publishToUpdateSet, wired to the set call 1 returned.
    expect(scripted.posts[1].fields.sysparm_function).toBe(
      "publishToUpdateSet",
    );
    expect(scripted.posts[1].fields.sysparm_update_set_id).toBe(US_SYS_ID);

    // Call 3 — the shared progress poller.
    expect(scripted.posts[2].fields.sysparm_processor).toBe(
      "AJAXProgressStatusChecker",
    );
    expect(scripted.posts[2].fields.sysparm_execution_id).toBe(
      US_WORKER_SYS_ID,
    );
  });

  it("keeps the update set sys_id when the publish call fails", async function () {
    // The set is already on the instance — losing its sys_id would strand it.
    var scripted = scriptedTransport([
      ok(CREATE_US_XML),
      { status: 500, location: "", body: "boom" },
    ]);
    var result = await publishApp(usParams({ transport: scripted.transport }));
    expect(result.status).toBe("failed");
    expect(result.updateSetSysId).toBe(US_SYS_ID);
    expect(result.note).toContain("EMPTY");
  });

  it("publishes nothing when the set cannot be created", async function () {
    var scripted = scriptedTransport([
      { status: 200, location: "", body: '<?xml version="1.0"?><xml/>' },
    ]);
    var result = await publishApp(usParams({ transport: scripted.transport }));
    expect(result.status).toBe("failed");
    expect(result.updateSetSysId).toBe("");
    expect(scripted.posts.length).toBe(1);
    expect(result.note).toContain("Nothing was published");
  });

  it("dry-runs both calls without posting", async function () {
    var scripted = scriptedTransport([ok(CREATE_US_XML)]);
    var result = await publishApp(
      usParams({ transport: scripted.transport, confirm: false }),
    );
    expect(result.status).toBe("dry-run");
    expect(scripted.posts.length).toBe(0);
    var preview = result.requestPreview || {};
    expect(preview["1.sysparm_function"]).toBe("createUpdateSet");
    expect(preview["2.sysparm_function"]).toBe("publishToUpdateSet");
    expect(preview["1.sysparm_description"]).toBe("20260729");
  });
});

describe("parsePublishTargets", function () {
  it("keeps 'both' as the store,repo alias", function () {
    expect(parsePublishTargets("both")).toEqual({
      targets: ["store", "repo"],
      error: "",
    });
  });

  it("accepts a single target", function () {
    expect(parsePublishTargets("update-set").targets).toEqual(["update-set"]);
  });

  it("accepts a comma-separated list and PRESERVES order", function () {
    // Order is load-bearing: the repo publish bumps sys_app.version, so the
    // update set must be captured after it.
    var parsed = parsePublishTargets("repo-ui,update-set");
    expect(parsed.error).toBe("");
    expect(parsed.targets).toEqual(["repo-ui", "update-set"]);
  });

  it("tolerates whitespace and empty segments", function () {
    expect(parsePublishTargets(" repo-ui , , update-set ").targets).toEqual([
      "repo-ui",
      "update-set",
    ]);
  });

  it("rejects an unknown target without throwing", function () {
    var parsed = parsePublishTargets("repo-ui,everywhere");
    expect(parsed.targets).toEqual([]);
    expect(parsed.error).toContain("everywhere");
  });

  it("rejects an empty value", function () {
    expect(parsePublishTargets("   ").error).toContain("empty");
  });
});
