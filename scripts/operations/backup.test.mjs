import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
  symlink,
  lstat,
  mkdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  backupKey,
  captureBackup,
  compareRestoredObjects,
  explicitPath,
  extractBackup,
  noSymlinks,
  validateObjectKey,
  verifyBackup,
} from "./backup-core.mjs";
import { postgresEnvironment, restoreLocalDatabase } from "./backup.mjs";

const freeze = "ALL_APPLICATION_AND_WORKER_WRITES_FROZEN";
const volume = "ISOLATED_ENCRYPTED_VOLUME_APPROVED";
const employeeDocument = Buffer.from("Synthetic private credential bytes only");
const aclMetadata = {
  "acl-policy": JSON.stringify({
    owner: "synthetic-user",
    visibility: "private",
  }),
  "content-sha256": createHash("sha256").update(employeeDocument).digest("hex"),
};
const objects = [
  {
    key: "private/uploads/11111111-1111-4111-8111-111111111111",
    bytes: employeeDocument.length,
    version: "fixture-v1",
  },
];

async function context(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "hch-backup-unit-"));
  t.after(async () => {
    // This directory was created by this test; refuse a broad or redirected cleanup.
    if (
      path.dirname(base) !== os.tmpdir() ||
      !path.basename(base).startsWith("hch-backup-unit-") ||
      (await lstat(base)).isSymbolicLink()
    )
      throw new Error("Unsafe fixture cleanup");
    await rm(base, { recursive: true });
  });
  const key = randomBytes(32);
  const directory = path.join(base, "encrypted");
  const destination = path.join(base, "restored");
  const options = {
    directory,
    key,
    releaseSha: "a".repeat(40),
    migrationVersion: "0001_fixture",
    sourceId: "b".repeat(64),
    writesFrozen: freeze,
    database: async () => ({
      stream: Readable.from([
        Buffer.from(
          "PGDMP synthetic custom-format stand-in; not a PostgreSQL restore test",
        ),
      ]),
      finished: Promise.resolve(),
    }),
    listObjects: async () => objects,
    readObject: async () => ({
      stream: Readable.from([employeeDocument]),
      contentType: "application/pdf",
      metadata: aclMetadata,
    }),
  };
  return {
    base,
    key,
    directory,
    destination,
    options,
    extract: {
      directory,
      destination,
      key,
      confirmation: `RESTORE_ISOLATED:${destination}`,
      encryptedVolumeAcknowledgement: volume,
    },
  };
}

test("encrypted roundtrip preserves database bytes, document bytes, hashes and ACL metadata", async (t) => {
  const c = await context(t);
  const result = await captureBackup(c.options);
  assert.equal(result.objectCount, 1);
  const manifest = await verifyBackup(c.directory, c.key);
  assert.equal(manifest.objects[0].sha256, aclMetadata["content-sha256"]);
  const restored = await extractBackup(c.extract);
  assert.equal(await compareRestoredObjects(restored, c.destination), 1);
  assert.deepEqual(
    await readFile(path.join(c.destination, "objects", objects[0].key)),
    employeeDocument,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(c.destination, "objects", `${objects[0].key}.metadata.json`),
      ),
    ),
    { contentType: "application/pdf", metadata: aclMetadata },
  );
  for (const file of await readdir(c.directory)) {
    const bytes = await readFile(path.join(c.directory, file));
    assert.equal(bytes.includes(employeeDocument), false);
    assert.equal(bytes.includes(Buffer.from("synthetic-user")), false);
    assert.equal(bytes.includes(Buffer.from(objects[0].key)), false);
  }
});

test("empty private bucket remains valid without creating synthetic runtime objects", async (t) => {
  const c = await context(t);
  const result = await captureBackup({
    ...c.options,
    listObjects: async () => [],
  });
  assert.equal(result.objectCount, 0);
  assert.equal((await verifyBackup(c.directory, c.key)).objects.length, 0);
});

test("missing write-freeze acknowledgement prevents any capture", async (t) => {
  const c = await context(t);
  await assert.rejects(
    captureBackup({ ...c.options, writesFrozen: "" }),
    /freeze/,
  );
  await assert.rejects(lstat(c.directory), { code: "ENOENT" });
});

test("backup and extraction refuse an existing directory even when empty", async (t) => {
  const c = await context(t);
  await captureBackup(c.options);
  await assert.rejects(captureBackup(c.options), { code: "EEXIST" });
  await mkdir(c.destination);
  await assert.rejects(extractBackup(c.extract), { code: "EEXIST" });
});

test("source inventory change fails closed without COMPLETE", async (t) => {
  const c = await context(t);
  let count = 0;
  await assert.rejects(
    captureBackup({
      ...c.options,
      listObjects: async () =>
        ++count === 1 ? objects : [{ ...objects[0], version: "changed" }],
    }),
    /inventory changed/,
  );
  await assert.rejects(lstat(path.join(c.directory, "COMPLETE")), {
    code: "ENOENT",
  });
  await assert.rejects(verifyBackup(c.directory, c.key));
});

test("failed PostgreSQL dump never marks backup complete", async (t) => {
  const c = await context(t);
  await assert.rejects(
    captureBackup({
      ...c.options,
      database: async () => ({
        stream: Readable.from([Buffer.from("dump-prefix")]),
        finished: Promise.resolve().then(() => {
          throw new Error("dump failed");
        }),
      }),
    }),
    /dump failed/,
  );
  await assert.rejects(lstat(path.join(c.directory, "COMPLETE")), {
    code: "ENOENT",
  });
});

test("truncated object response refuses success", async (t) => {
  const c = await context(t);
  await assert.rejects(
    captureBackup({
      ...c.options,
      readObject: async () => ({
        stream: Readable.from([Buffer.from("x")]),
        contentType: "image/jpeg",
        metadata: {},
      }),
    }),
    /changed during backup/,
  );
  await assert.rejects(lstat(path.join(c.directory, "COMPLETE")), {
    code: "ENOENT",
  });
});

for (const corrupt of ["manifest", "database", "object", "truncated"]) {
  test(`${corrupt} corruption fails authentication before creating restore destination`, async (t) => {
    const c = await context(t);
    await captureBackup(c.options);
    const manifest = await verifyBackup(c.directory, c.key);
    const name =
      corrupt === "manifest"
        ? "manifest.aead"
        : corrupt === "database"
          ? manifest.database.blob
          : manifest.objects[0].blob;
    const file = path.join(c.directory, name);
    const bytes = await readFile(file);
    bytes[25] ^= 1;
    await writeFile(
      file,
      corrupt === "truncated" ? bytes.subarray(0, 24) : bytes,
    );
    await assert.rejects(extractBackup(c.extract));
    await assert.rejects(lstat(c.destination), { code: "ENOENT" });
  });
}

test("wrong encryption key refuses restore", async (t) => {
  const c = await context(t);
  await captureBackup(c.options);
  await assert.rejects(extractBackup({ ...c.extract, key: randomBytes(32) }));
  await assert.rejects(lstat(c.destination), { code: "ENOENT" });
});

test("swapping authenticated object and database blobs is rejected by AAD", async (t) => {
  const c = await context(t);
  await captureBackup(c.options);
  const manifest = await verifyBackup(c.directory, c.key);
  const dbFile = path.join(c.directory, manifest.database.blob),
    docFile = path.join(c.directory, manifest.objects[0].blob);
  const db = await readFile(dbFile),
    doc = await readFile(docFile);
  await writeFile(dbFile, doc);
  await writeFile(docFile, db);
  await assert.rejects(verifyBackup(c.directory, c.key));
});

test("missing or extra artifact invalidates backup completeness", async (t) => {
  const c = await context(t);
  await captureBackup(c.options);
  await writeFile(path.join(c.directory, "unexpected.txt"), "not in manifest", {
    flag: "wx",
  });
  await assert.rejects(verifyBackup(c.directory, c.key), /Unexpected/);
});

test("changed restored bytes or metadata fails post-extraction verification", async (t) => {
  const c = await context(t);
  await captureBackup(c.options);
  const manifest = await extractBackup(c.extract);
  await writeFile(
    path.join(c.destination, "objects", `${objects[0].key}.metadata.json`),
    JSON.stringify({ contentType: "application/pdf", metadata: {} }),
  );
  await assert.rejects(
    compareRestoredObjects(manifest, c.destination),
    /mismatch/,
  );
});

test("symlink/junction source and destination ancestors are refused", async (t) => {
  const c = await context(t);
  await captureBackup(c.options);
  const link = path.join(c.base, "redirect");
  try {
    await symlink(
      c.directory,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error.code === "EPERM")
      return t.skip("OS does not permit test symlink creation");
    throw error;
  }
  await assert.rejects(noSymlinks(link), /Symlink/);
  await assert.rejects(
    noSymlinks(path.join(link, "new"), { allowMissingLeaf: true }),
    /Symlink/,
  );
});

test("public object ACL is never accepted into a private backup", async (t) => {
  const c = await context(t);
  await assert.rejects(
    captureBackup({
      ...c.options,
      readObject: async () => ({
        stream: Readable.from([employeeDocument]),
        contentType: "image/jpeg",
        metadata: { "acl-policy": '{"visibility":"public"}' },
      }),
    }),
    /Non-private/,
  );
});

test("duplicate inventory entries refused", async (t) => {
  const c = await context(t);
  await assert.rejects(
    captureBackup({
      ...c.options,
      listObjects: async () => [...objects, ...objects],
    }),
    /inventory item/,
  );
});

test("explicit destination and encrypted-volume acknowledgements required", async (t) => {
  const c = await context(t);
  await captureBackup(c.options);
  await assert.rejects(
    extractBackup({ ...c.extract, confirmation: "yes" }),
    /acknowledgement/,
  );
  await assert.rejects(
    extractBackup({ ...c.extract, encryptedVolumeAcknowledgement: "" }),
    /acknowledgement/,
  );
});

test("broad, relative, unresolved and wildcard filesystem paths refused", () => {
  for (const value of [
    path.parse(process.cwd()).root,
    process.cwd(),
    os.homedir(),
    "relative",
    path.join(os.tmpdir(), "*.dump"),
    path.join(os.tmpdir(), "$BACKUP"),
    `${os.tmpdir()}${path.sep}..${path.sep}unsafe`,
  ])
    assert.throws(() => explicitPath(value));
});

test("object keys refuse traversal, sidecar collisions, reserved names and Windows ambiguity", () => {
  for (const value of [
    "private/../escape",
    "private/./file",
    "private//file",
    "private/a\\file",
    "private/C:/file",
    "public/file",
    "private/CON",
    "private/file.",
    "private/file.metadata.json",
    "private/aux.txt",
    "private/a%2Fb",
  ])
    assert.throws(() => validateObjectKey(value));
});

test("encryption key requires canonical random-sized material", () => {
  assert.equal(backupKey(randomBytes(32).toString("base64")).length, 32);
  for (const input of [
    "",
    "password",
    randomBytes(31).toString("base64"),
    randomBytes(32).toString("base64") + "\n",
  ])
    assert.throws(() => backupKey(input));
});

test("dedicated PostgreSQL environment never inherits app credentials/options", () => {
  const env = {
    BACKUP_PGHOST: "db.example.invalid",
    BACKUP_PGPORT: "5432",
    BACKUP_PGDATABASE: "source",
    BACKUP_PGUSER: "backup_reader",
    BACKUP_PGPASSWORD: "fixture-only",
    BACKUP_PGSSLMODE: "verify-full",
    DATABASE_URL: "never inherited",
    PGOPTIONS: "never inherited",
    PGHOSTADDR: "never inherited",
    PGSERVICE: "never inherited",
  };
  const result = postgresEnvironment(env, "BACKUP_");
  assert.equal(result.DATABASE_URL, undefined);
  assert.equal(result.PGOPTIONS, undefined);
  assert.equal(result.PGHOSTADDR, undefined);
  assert.equal(result.PGSERVICE, undefined);
  assert.throws(
    () =>
      postgresEnvironment({ ...env, BACKUP_PGSSLMODE: "require" }, "BACKUP_"),
    /verified TLS/,
  );
});

test("restore refuses remote, production-named and unconfirmed DB before invoking a command", async () => {
  for (const pgEnv of [
    { PGHOST: "remote.example.invalid", PGDATABASE: "hch_restore_test" },
    { PGHOST: "127.0.0.1", PGDATABASE: "production" },
    { PGHOST: "127.0.0.1", PGDATABASE: "hch_restore_test" },
  ])
    await assert.rejects(
      restoreLocalDatabase({
        pgBin: "/unavailable",
        pgEnv,
        dumpPath: "/unavailable",
        confirmation: "yes",
      }),
      /confirmation/,
    );
});

test("libpq service/address overrides cannot redirect a loopback restore", async () => {
  for (const override of [
    "PGHOSTADDR",
    "PGSERVICE",
    "PGSERVICEFILE",
    "PGOPTIONS",
    "DATABASE_URL",
  ]) {
    await assert.rejects(
      restoreLocalDatabase({
        pgBin: "/unavailable",
        pgEnv: {
          PGHOST: "127.0.0.1",
          PGDATABASE: "hch_restore_test",
          [override]: "not-allowed",
        },
        dumpPath: "/unavailable",
        confirmation: "RESTORE_DATABASE:hch_restore_test",
      }),
      /override refused/,
    );
  }
});
