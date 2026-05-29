import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import {
  readSchemaTree,
  writeSnapshot,
  listSnapshots,
  resolveSnapshotDir,
} from "../snapshot";
import { SchemaIndex } from "../types";

async function makeTmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "dove-schema-test-"));
}

async function writeTree(root: string) {
  // Two apps under one output dir, matching organizer's layout.
  await fsp.mkdir(path.join(root, "journey"), { recursive: true });
  await fsp.mkdir(path.join(root, "work"), { recursive: true });

  await fsp.writeFile(
    path.join(root, "journey", "x_cadso_journey_action.json"),
    JSON.stringify({
      table_name: "x_cadso_journey_action",
      label: "Action",
      scope: "x_cadso_journey",
      created_at: "2025-01-01T00:00:00.000Z",
      fields: [
        { name: "state", label: "State", type: "string", max_length: "40", mandatory: false, reference: "", default_value: "draft", inherited_from: null },
      ],
    })
  );
  await fsp.writeFile(
    path.join(root, "work", "x_cadso_work_project.json"),
    JSON.stringify({
      table_name: "x_cadso_work_project",
      label: "Project",
      scope: "x_cadso_work",
      fields: [{ name: "name", label: "Name", type: "string", max_length: "100", mandatory: true, reference: "", default_value: "", inherited_from: null }],
    })
  );

  var index: SchemaIndex = {
    instance: "demo.service-now.com",
    generated_at: "2025-01-01T00:00:00.000Z",
    total_tables: 2,
    scopes: ["x_cadso_journey", "x_cadso_work"],
    applications: [
      { name: "journey", table_count: 1, tables: ["x_cadso_journey_action"] },
      { name: "work", table_count: 1, tables: ["x_cadso_work_project"] },
    ],
  };
  await fsp.writeFile(path.join(root, "index.json"), JSON.stringify(index));
  return index;
}

describe("readSchemaTree", function () {
  it("reads all tables and carries instance/generated_at from index.json", async function () {
    var root = await makeTmp();
    await writeTree(root);
    var s = await readSchemaTree({ dir: root });
    expect(Object.keys(s.tables).sort()).toEqual(["x_cadso_journey_action", "x_cadso_work_project"]);
    expect(s.instance).toBe("demo.service-now.com");
    expect(s.generated_at).toBe("2025-01-01T00:00:00.000Z");
  });

  it("filters by scope using the table-name prefix", async function () {
    var root = await makeTmp();
    await writeTree(root);
    var s = await readSchemaTree({ dir: root, scope: "x_cadso_journey" });
    expect(Object.keys(s.tables)).toEqual(["x_cadso_journey_action"]);
  });

  it("throws for a missing directory", async function () {
    await expect(readSchemaTree({ dir: "/no/such/dir/here" })).rejects.toThrow();
  });
});

describe("writeSnapshot / listSnapshots / resolveSnapshotDir", function () {
  it("persists an immutable snapshot and round-trips through list + resolve", async function () {
    var root = await makeTmp();
    var index = await writeTree(root);

    var info = await writeSnapshot({
      outputDir: root,
      index,
      label: "pre-release",
      now: "2026-05-29T16:30:00.123Z",
    });
    expect(info.label).toBe("pre-release");
    expect(info.total_tables).toBe(2);

    // manifest + copied tree exist
    var manifest = JSON.parse(await fsp.readFile(path.join(info.dir, "snapshot.json"), "utf8"));
    expect(manifest.instance).toBe("demo.service-now.com");
    var copied = await readSchemaTree({ dir: info.dir });
    expect(Object.keys(copied.tables).length).toBe(2);

    var list = await listSnapshots({ outputDir: root, instance: "demo.service-now.com" });
    expect(list.length).toBe(1);

    // resolve by label
    var byLabel = await resolveSnapshotDir({ ref: "pre-release", outputDir: root, instance: "demo.service-now.com" });
    expect(byLabel).toBe(info.dir);

    // resolve by directory name
    var dirName = path.basename(info.dir);
    var byName = await resolveSnapshotDir({ ref: dirName, outputDir: root, instance: "demo.service-now.com" });
    expect(byName).toBe(info.dir);
  });

  it("refuses to overwrite an existing snapshot (immutability)", async function () {
    var root = await makeTmp();
    var index = await writeTree(root);
    var opts = { outputDir: root, index: index, label: "dup", now: "2026-05-29T16:30:00.000Z" };
    await writeSnapshot(opts);
    await expect(writeSnapshot(opts)).rejects.toThrow(/immutable/);
  });

  it("resolves an explicit directory path ref", async function () {
    var root = await makeTmp();
    await writeTree(root);
    var resolved = await resolveSnapshotDir({ ref: root, outputDir: root, instance: "demo.service-now.com" });
    expect(resolved).toBe(path.resolve(root));
  });
});
