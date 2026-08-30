// Optional real PostgreSQL drill. Never reads application/provider credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  captureBackup,
  compareRestoredObjects,
  extractBackup,
  noSymlinks,
  verifyBackup,
} from "./backup-core.mjs";
import { pgProcess, restoreLocalDatabase } from "./backup.mjs";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const pgBin = process.env.HCH_BACKUP_DRILL_PG_BIN;

test(
  "isolated PostgreSQL dump/restore + private document/ACL roundtrip and corruption rejection",
  { skip: !pgBin, timeout: 120_000 },
  async (t) => {
    const local = path.join(repo, ".local");
    await mkdir(local, { recursive: true });
    await noSymlinks(local);
    const base = await mkdtemp(path.join(local, "backup-drill-"));
    const data = path.join(base, "pgdata");
    const passwordPath = path.join(base, "fixture-password");
    const password = randomBytes(32).toString("hex");
    const secretKey = randomBytes(32);
    await writeFile(passwordPath, password, { mode: 0o600, flag: "wx" });
    const env = {};
    for (const name of [
      "PATH",
      "SystemRoot",
      "SYSTEMROOT",
      "WINDIR",
      "TEMP",
      "TMP",
      "TMPDIR",
    ])
      if (process.env[name]) env[name] = process.env[name];
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    Object.assign(env, {
      PGHOST: "127.0.0.1",
      PGPORT: String(port),
      PGDATABASE: "postgres",
      PGUSER: "fixture_admin",
      PGPASSWORD: password,
      PGSSLMODE: "disable",
      PGCONNECT_TIMEOUT: "5",
    });
    let started = false;
    async function tool(name, args) {
      if (!["initdb", "pg_ctl"].includes(name))
        throw new Error("Invalid drill tool");
      const executable = await noSymlinks(
        path.join(
          pgBin,
          `${name}${process.platform === "win32" ? ".exe" : ""}`,
        ),
      );
      return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
          env,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore"],
        });
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`Disposable PostgreSQL ${name} failed`)),
        );
      });
    }
    async function sql(database, command) {
      const result = await pgProcess(
        pgBin,
        "psql",
        [
          "--no-psqlrc",
          "--no-password",
          "--tuples-only",
          "--no-align",
          "--set=ON_ERROR_STOP=1",
          `--command=${command}`,
        ],
        { ...env, PGDATABASE: database },
      );
      let output = "";
      for await (const chunk of result.stream) output += chunk.toString("utf8");
      await result.finished;
      return output.trim();
    }
    t.after(async () => {
      if (started)
        await tool("pg_ctl", [
          "-D",
          data,
          "-m",
          "fast",
          "-w",
          "-t",
          "20",
          "stop",
        ]);
      secretKey.fill(0);
      // Only the newly-created, exact fixture tree may be removed. No old clusters.
      if (
        path.dirname(base) !== local ||
        !path.basename(base).startsWith("backup-drill-") ||
        (await lstat(base)).isSymbolicLink()
      )
        throw new Error("Unsafe drill cleanup");
      await rm(base, { recursive: true });
    });
    await tool("initdb", [
      "-D",
      data,
      "--encoding=UTF8",
      "--locale=C",
      "--username=fixture_admin",
      "--auth-host=scram-sha-256",
      "--auth-local=scram-sha-256",
      `--pwfile=${passwordPath}`,
    ]);
    await rm(passwordPath);
    await tool("pg_ctl", [
      "-D",
      data,
      "-l",
      path.join(base, "postgres.log"),
      "-o",
      // TCP only: Linux runners cannot write the system PostgreSQL socket dir.
      `-h 127.0.0.1 -p ${port}${process.platform === "win32" ? "" : " -c unix_socket_directories=''"}`,
      "-w",
      "-t",
      "20",
      "start",
    ]);
    started = true;
    await sql("postgres", "CREATE DATABASE hch_fixture_source;");
    await sql("postgres", "CREATE DATABASE hch_restore_verified;");
    await sql("postgres", "CREATE DATABASE hch_restore_corrupt;");
    await sql("postgres", "CREATE DATABASE hch_restore_routine;");
    await sql(
      "hch_restore_routine",
      "CREATE FUNCTION fixture_existing_function() RETURNS integer LANGUAGE sql AS 'SELECT 1';",
    );
    const journal = JSON.parse(
      await readFile(
        path.join(repo, "lib/db/migrations/meta/_journal.json"),
        "utf8",
      ),
    );
    for (const entry of journal.entries) {
      const command = await pgProcess(
        pgBin,
        "psql",
        [
          "--no-psqlrc",
          "--no-password",
          "--set=ON_ERROR_STOP=1",
          `--file=${path.join(repo, "lib/db/migrations", `${entry.tag}.sql`)}`,
        ],
        { ...env, PGDATABASE: "hch_fixture_source" },
      );
      command.stream.resume();
      await command.finished;
    }
    await sql(
      "hch_fixture_source",
      `INSERT INTO facilities (name,name_ar) VALUES ('Synthetic Facility A','Synthetic A'),('Synthetic Facility B','Synthetic B');
    INSERT INTO users (email,password_hash,name,name_ar,role,facility_id) VALUES ('employee-a@example.invalid','not-a-login-hash','Synthetic A','Synthetic A','employee',1),('employee-b@example.invalid','not-a-login-hash','Synthetic B','Synthetic B','employee',2);
    INSERT INTO credentials (employee_id,type,holder_name,holder_name_ar,issuer_name,issuer_name_ar,certificate_number,issue_date,expiry_date,file_url,file_type,qr_token) VALUES (1,'BLS','Synthetic A','Synthetic A','Fixture Issuer','Fixture Issuer','FIXTURE-A','2026-01-01','2028-01-01','/objects/uploads/11111111-1111-4111-8111-111111111111','application/pdf','fixture-a'),(2,'BLS','Synthetic B','Synthetic B','Fixture Issuer','Fixture Issuer','FIXTURE-B','2026-01-01','2028-01-01','/objects/uploads/22222222-2222-4222-8222-222222222222','image/jpeg','fixture-b');`,
    );
    const fixtureObjects = [
      {
        key: "private/uploads/11111111-1111-4111-8111-111111111111",
        bytes: Buffer.from(
          "%PDF-1.7 synthetic fixture, not a real worker document",
        ),
        contentType: "application/pdf",
        metadata: { "acl-policy": '{"owner":"1","visibility":"private"}' },
      },
      {
        key: "private/uploads/22222222-2222-4222-8222-222222222222",
        bytes: Buffer.from(
          "Synthetic JPEG payload; tests do not exercise the upload parser",
        ),
        contentType: "image/jpeg",
        metadata: { "acl-policy": '{"owner":"2","visibility":"private"}' },
      },
    ];
    const archive = path.join(base, "encrypted-backup");
    const destination = path.join(base, "restored-data");
    const sourceRows = await sql(
      "hch_fixture_source",
      `SELECT json_build_object('facilities',(SELECT json_agg(row_to_json(f)) FROM facilities f),'users',(SELECT json_agg(row_to_json(u)) FROM users u),'credentials',(SELECT json_agg(row_to_json(c)) FROM credentials c));`,
    );
    const sourceTables = await sql(
      "hch_fixture_source",
      `SELECT string_agg(tablename,',' ORDER BY tablename) FROM pg_tables WHERE schemaname='public';`,
    );
    const startedAt = Date.now();
    const result = await captureBackup({
      directory: archive,
      key: secretKey,
      releaseSha: "a".repeat(40),
      migrationVersion: journal.entries.at(-1).tag,
      sourceId: createHash("sha256").update(randomUUID()).digest("hex"),
      writesFrozen: "ALL_APPLICATION_AND_WORKER_WRITES_FROZEN",
      database: () =>
        pgProcess(
          pgBin,
          "pg_dump",
          ["--format=custom", "--no-owner", "--no-acl", "--no-password"],
          { ...env, PGDATABASE: "hch_fixture_source" },
        ),
      listObjects: async () =>
        fixtureObjects.map((file) => ({
          key: file.key,
          bytes: file.bytes.length,
          version: "immutable-synthetic-v1",
        })),
      readObject: async (entry) => {
        const file = fixtureObjects.find((item) => item.key === entry.key);
        return {
          stream: Readable.from([file.bytes]),
          metadata: file.metadata,
          contentType: file.contentType,
        };
      },
    });
    const manifest = await verifyBackup(archive, secretKey);
    await extractBackup({
      directory: archive,
      destination,
      key: secretKey,
      confirmation: `RESTORE_ISOLATED:${destination}`,
      encryptedVolumeAcknowledgement: "ISOLATED_ENCRYPTED_VOLUME_APPROVED",
    });
    await restoreLocalDatabase({
      pgBin,
      pgEnv: { ...env, PGDATABASE: "hch_restore_verified" },
      dumpPath: path.join(destination, "database.dump"),
      confirmation: "RESTORE_DATABASE:hch_restore_verified",
    });
    const restoredRows = await sql(
      "hch_restore_verified",
      `SELECT json_build_object('facilities',(SELECT json_agg(row_to_json(f)) FROM facilities f),'users',(SELECT json_agg(row_to_json(u)) FROM users u),'credentials',(SELECT json_agg(row_to_json(c)) FROM credentials c));`,
    );
    const restoredTables = await sql(
      "hch_restore_verified",
      `SELECT string_agg(tablename,',' ORDER BY tablename) FROM pg_tables WHERE schemaname='public';`,
    );
    assert.equal(restoredRows, sourceRows);
    assert.equal(restoredTables, sourceTables);
    assert.equal(await compareRestoredObjects(manifest, destination), 2);
    // A second invocation must not overwrite a target that contains restored data.
    await assert.rejects(
      restoreLocalDatabase({
        pgBin,
        pgEnv: { ...env, PGDATABASE: "hch_restore_verified" },
        dumpPath: path.join(destination, "database.dump"),
        confirmation: "RESTORE_DATABASE:hch_restore_verified",
      }),
      /not empty/,
    );
    await assert.rejects(
      restoreLocalDatabase({
        pgBin,
        pgEnv: { ...env, PGDATABASE: "hch_restore_routine" },
        dumpPath: path.join(destination, "database.dump"),
        confirmation: "RESTORE_DATABASE:hch_restore_routine",
      }),
      /not empty/,
    );
    const corruptArchive = path.join(base, "corrupted-backup");
    await cp(archive, corruptArchive, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const corruptPath = path.join(corruptArchive, manifest.objects[1].blob);
    const bytes = await readFile(corruptPath);
    bytes[24] ^= 1;
    await writeFile(corruptPath, bytes);
    const corruptDestination = path.join(base, "must-not-exist");
    await assert.rejects(
      extractBackup({
        directory: corruptArchive,
        destination: corruptDestination,
        key: secretKey,
        confirmation: `RESTORE_ISOLATED:${corruptDestination}`,
        encryptedVolumeAcknowledgement: "ISOLATED_ENCRYPTED_VOLUME_APPROVED",
      }),
    );
    await assert.rejects(lstat(corruptDestination), { code: "ENOENT" });
    assert.equal(
      await sql(
        "hch_restore_corrupt",
        `SELECT count(*) FROM pg_tables WHERE schemaname='public';`,
      ),
      "0",
    );
    const elapsedMs = Date.now() - startedAt;
    t.diagnostic(
      JSON.stringify({
        scenario: "isolated-synthetic-postgres-and-local-documents",
        status: "passed",
        schemaMigrations: journal.entries.length,
        restoredTables: sourceTables.split(",").length,
        facilities: 2,
        users: 2,
        credentials: 2,
        objects: result.objectCount,
        databaseBytes: result.databaseBytes,
        checksumAndAclMatches: true,
        corruptionRejectedBeforeRestore: true,
        elapsedMs,
        liveProviderBackup: false,
      }),
    );
  },
);
