import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openCatalog } from "../src/db.ts";

const OLD_TABLE = `CREATE TABLE dependency_edges (
  id              INTEGER PRIMARY KEY,
  machine_id      TEXT NOT NULL REFERENCES machines(id),
  from_install_id INTEGER NOT NULL REFERENCES installs(id),
  to_install_id   INTEGER REFERENCES installs(id),
  to_ecosystem    TEXT NOT NULL,
  to_key          TEXT NOT NULL,
  to_name         TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('library','runtime')),
  "constraint"    TEXT,
  built_against   TEXT,
  source          TEXT NOT NULL CHECK (source IN ('brew-deps','npm-engines','pyvenv')),
  evidence        TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  UNIQUE (from_install_id, to_ecosystem, to_key, kind, source)
)`;

test("a catalog whose dependency_edges table limits the source gains the reviewed source and keeps its rows", () => {
  const path = `${process.env["TEMP"] ?? process.env["TMPDIR"] ?? "/tmp"}/scout-dependency-migration-${process.pid}.db`;
  const first = openCatalog(path);
  first.exec("PRAGMA foreign_keys = OFF");
  first.exec("DROP TABLE dependency_edges");
  first.exec(OLD_TABLE);
  first.prepare("INSERT INTO machines (id, name, os, kind) VALUES ('m', 'M', 'macos', 'host')").run();
  first.exec("INSERT INTO sources (id, machine_id, kind, location) VALUES (1, 'm', 'brew', '')");
  first.exec("INSERT INTO packages (id, ecosystem, key, name) VALUES (1, 'brew', 'a', 'a')");
  first.exec("INSERT INTO installs (id, machine_id, package_id, source_id, location, kind, first_seen, last_seen) VALUES (1, 'm', 1, 1, '', 'package', 't', 't')");
  first.exec("INSERT INTO dependency_edges (machine_id, from_install_id, to_ecosystem, to_key, to_name, kind, source, evidence, observed_at) VALUES ('m', 1, 'brew', 'b', 'b', 'library', 'brew-deps', 'e', 't')");
  assert.throws(() => first.exec("INSERT INTO dependency_edges (machine_id, from_install_id, to_ecosystem, to_key, to_name, kind, source, evidence, observed_at) VALUES ('m', 1, 'brew', 'c', 'c', 'library', 'ai-reviewed', 'e', 't')"));
  first.close();
  const second = openCatalog(path);
  assert.equal((second.prepare("SELECT COUNT(*) AS n FROM dependency_edges").get() as { n: number }).n, 1);
  second.exec("INSERT INTO dependency_edges (machine_id, from_install_id, to_ecosystem, to_key, to_name, kind, source, evidence, observed_at) VALUES ('m', 1, 'brew', 'c', 'c', 'library', 'ai-reviewed', 'e', 't')");
  assert.equal((second.prepare("SELECT COUNT(*) AS n FROM dependency_edges").get() as { n: number }).n, 2);
  assert.equal(second.prepare("SELECT 1 FROM sqlite_master WHERE name = 'dependency_edges_old'").get(), undefined);
  second.close();
  new DatabaseSync(path).close();
});
