import { z } from "zod";
import { registerKitTool, registerKitTools } from "../register";
import { READ_ONLY } from "../annotations";
import type { KitToolDescriptor } from "../descriptor";

interface Captured {
  name: string;
  config: any;
  handler: (args: any) => Promise<any>;
}

function fakeServer(captured: Captured[]): any {
  return {
    registerTool: function (name: string, config: any, handler: any) {
      captured.push({ name: name, config: config, handler: handler });
    }
  };
}

function descriptor(over: Partial<KitToolDescriptor>): KitToolDescriptor {
  return Object.assign(
    {
      name: "t_read",
      description: "a tool",
      shape: { x: z.string() },
      annotations: READ_ONLY,
      handler: async function () {
        return { ok: true };
      }
    },
    over
  ) as KitToolDescriptor;
}

describe("registerKitTool", function () {
  it("registers name + description + inputSchema + annotations with the server", function () {
    var cap: Captured[] = [];
    registerKitTool(fakeServer(cap), descriptor({}));
    expect(cap.length).toBe(1);
    expect(cap[0].name).toBe("t_read");
    expect(cap[0].config.description).toBe("a tool");
    expect(cap[0].config.inputSchema).toBeDefined();
    expect(cap[0].config.annotations).toBe(READ_ONLY);
    expect(cap[0].config.outputSchema).toBeUndefined();
  });

  it("wraps the handler result in a text content block (no structuredContent)", async function () {
    var cap: Captured[] = [];
    registerKitTool(
      fakeServer(cap),
      descriptor({ handler: async function () { return { a: 1 }; } })
    );
    var res = await cap[0].handler({});
    expect(res.structuredContent).toBeUndefined();
    expect(res.content[0].type).toBe("text");
    expect(JSON.parse(res.content[0].text)).toEqual({ a: 1 });
  });

  it("returns structuredContent AND text when outputSchema is set", async function () {
    var cap: Captured[] = [];
    registerKitTool(
      fakeServer(cap),
      descriptor({ outputSchema: { a: z.number() }, handler: async function () { return { a: 1 }; } })
    );
    expect(cap[0].config.outputSchema).toBeDefined();
    var res = await cap[0].handler({});
    expect(res.structuredContent).toEqual({ a: 1 });
    expect(JSON.parse(res.content[0].text)).toEqual({ a: 1 });
  });

  it("maps a thrown error to { error, retryable, tool } with isError", async function () {
    var cap: Captured[] = [];
    registerKitTool(
      fakeServer(cap),
      descriptor({ name: "t_fail", handler: async function () { throw new Error("rate limit hit"); } })
    );
    var res = await cap[0].handler({});
    expect(res.isError).toBe(true);
    var body = JSON.parse(res.content[0].text);
    expect(body.error).toBe("rate limit hit");
    expect(body.retryable).toBe(true);
    expect(body.tool).toBe("t_fail");
  });

  it("classifies a non-transient error as not retryable", async function () {
    var cap: Captured[] = [];
    registerKitTool(
      fakeServer(cap),
      descriptor({ name: "t_404", handler: async function () { throw new Error("404 not found"); } })
    );
    var res = await cap[0].handler({});
    expect(JSON.parse(res.content[0].text).retryable).toBe(false);
  });

  it("invokes the injected telemetry wrapper around the handler", async function () {
    var cap: Captured[] = [];
    var calls: string[] = [];
    var telemetry = async function <T>(tool: string, _args: unknown, fn: () => Promise<T>): Promise<T> {
      calls.push(tool);
      return fn();
    };
    registerKitTool(fakeServer(cap), descriptor({ name: "t_tel" }), { telemetry: telemetry });
    await cap[0].handler({ x: "y" });
    expect(calls).toEqual(["t_tel"]);
  });

  it("runs without telemetry when none is injected", async function () {
    var cap: Captured[] = [];
    registerKitTool(fakeServer(cap), descriptor({}));
    var res = await cap[0].handler({});
    expect(res.content[0].type).toBe("text");
  });
});

describe("registerKitTools", function () {
  it("registers every descriptor in the list", function () {
    var cap: Captured[] = [];
    registerKitTools(fakeServer(cap), [
      descriptor({ name: "a" }),
      descriptor({ name: "b" }),
      descriptor({ name: "c" })
    ]);
    expect(cap.map(function (c) { return c.name; })).toEqual(["a", "b", "c"]);
  });
});
