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

function storeParams(
  overrides: Partial<PublishAppParams>,
): PublishAppParams {
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
    expect(classifyProgress(failed)).toEqual({ terminal: true, success: false });
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
        links: { progress: { id: "prog123", url: "https://x/progress/prog123" } },
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
    await expect(
      publishApp(storeParams({ app: "" })),
    ).rejects.toThrow(/app .* required/);
    await expect(
      publishApp(storeParams({ version: "" })),
    ).rejects.toThrow(/version is required/);
    await expect(
      publishApp(
        storeParams({ target: "everywhere" as unknown as "store" }),
      ),
    ).rejects.toThrow(/target must be 'store' or 'repo'/);
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
      publishApp(storeParams({ client: ctx.client }))
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

  function repoParams(
    client: PublishAppParams["client"],
  ): PublishAppParams {
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
