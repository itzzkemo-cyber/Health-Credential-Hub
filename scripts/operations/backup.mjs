#!/usr/bin/env node
// No application .env is loaded. Use a dedicated approved backup runner.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  backupKey,
  captureBackup,
  compareRestoredObjects,
  explicitPath,
  extractBackup,
  noSymlinks,
  verifyBackup,
} from "./backup-core.mjs";

const requireApi = createRequire(
  new URL("../../artifacts/api-server/package.json", import.meta.url),
);
const approvedPgNames = new Set(["pg_dump", "pg_restore", "psql"]);
const PRIVATE_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

const required = (env, name) => {
  if (!env[name] || env[name] !== env[name].trim())
    throw new Error(`${name} must be supplied by the backup runner`);
  return env[name];
};

export function postgresEnvironment(env, prefix, { restore = false } = {}) {
  // Never inherit application DATABASE_URL, PGOPTIONS, PGHOSTADDR or services.
  const result = {};
  for (const name of [
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
  ])
    if (env[name]) result[name] = env[name];
  for (const name of [
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "PGSSLMODE",
  ])
    result[name] = required(env, `${prefix}${name}`);
  for (const name of ["PGSSLROOTCERT"])
    if (env[`${prefix}${name}`]) result[name] = env[`${prefix}${name}`];
  result.PGCONNECT_TIMEOUT = "15";
  if (
    !/^[0-9]{1,5}$/.test(result.PGPORT) ||
    +result.PGPORT < 1 ||
    +result.PGPORT > 65535 ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(result.PGUSER) ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(result.PGDATABASE)
  )
    throw new Error("Invalid PostgreSQL connection identity");
  if (restore) {
    if (
      !["127.0.0.1", "::1"].includes(result.PGHOST) ||
      !/^hch_restore_[a-z0-9_]{1,40}$/.test(result.PGDATABASE) ||
      !["disable", "verify-full"].includes(result.PGSSLMODE)
    )
      throw new Error(
        "Restore requires an isolated loopback hch_restore_* database",
      );
  } else {
    if (
      !/^[a-z0-9.-]+$/i.test(result.PGHOST) ||
      result.PGSSLMODE !== "verify-full"
    )
      throw new Error(
        "Backup requires an explicit database host and verified TLS",
      );
  }
  return result;
}

export async function pgExecutable(pgBin, name) {
  if (!approvedPgNames.has(name)) throw new Error("Unapproved PostgreSQL tool");
  const candidate = path.join(
    explicitPath(pgBin),
    `${name}${process.platform === "win32" ? ".exe" : ""}`,
  );
  await noSymlinks(candidate);
  if (!(await lstat(candidate)).isFile())
    throw new Error("PostgreSQL executable is absent");
  return candidate;
}

export async function pgProcess(pgBin, name, args, env) {
  const executable = await pgExecutable(pgBin, name);
  const child = spawn(executable, args, {
    env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // stderr may contain identifiers, hostnames or secrets: never retain/print it.
  child.stderr.resume();
  const timer = setTimeout(() => child.kill(), 15 * 60 * 1000);
  const finished = new Promise((resolve, reject) => {
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("PostgreSQL tool could not start"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(
            new Error("PostgreSQL tool failed; backup/restore is incomplete"),
          );
    });
  });
  // The consumer may still be piping while the process exits. Mark handled now.
  finished.catch(() => {});
  child.stdout.once("error", () => child.kill());
  return { stream: child.stdout, finished, cancel: () => child.kill() };
}

async function pgText(pgBin, name, args, env) {
  const operation = await pgProcess(pgBin, name, args, env);
  let output = "";
  try {
    for await (const bytes of operation.stream) {
      output += bytes.toString("utf8");
      if (output.length > 65536)
        throw new Error("Unexpected PostgreSQL diagnostic output");
    }
    await operation.finished;
    return output.trim();
  } catch (error) {
    operation.cancel();
    throw error;
  }
}

export async function restoreLocalDatabase({
  pgBin,
  pgEnv,
  dumpPath,
  confirmation,
}) {
  if (
    !["127.0.0.1", "::1"].includes(pgEnv.PGHOST) ||
    !/^hch_restore_[a-z0-9_]{1,40}$/.test(pgEnv.PGDATABASE) ||
    confirmation !== `RESTORE_DATABASE:${pgEnv.PGDATABASE}`
  )
    throw new Error("Local restore target confirmation required");
  if (
    [
      "PGHOSTADDR",
      "PGSERVICE",
      "PGSERVICEFILE",
      "PGOPTIONS",
      "DATABASE_URL",
    ].some((name) => pgEnv[name])
  )
    throw new Error("PostgreSQL target override refused");
  await noSymlinks(dumpPath);
  // Validate the custom archive before connecting, and refuse a nonempty target.
  const handle = await open(dumpPath, "r");
  try {
    const magic = Buffer.alloc(5);
    await handle.read(magic, 0, 5, 0);
    if (magic.toString("ascii") !== "PGDMP")
      throw new Error("Not a PostgreSQL custom-format dump");
  } finally {
    await handle.close();
  }
  // --list validates archive structure; consume output without logging it.
  const check = await pgProcess(
    pgBin,
    "pg_restore",
    ["--list", dumpPath],
    pgEnv,
  );
  check.stream.resume();
  await check.finished;
  const empty = await pgText(
    pgBin,
    "psql",
    [
      "--no-psqlrc",
      "--no-password",
      "--set=ON_ERROR_STOP=1",
      "--tuples-only",
      "--no-align",
      "--command=WITH user_namespaces AS (SELECT oid,nspname FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%') SELECT (SELECT count(*) FROM pg_catalog.pg_class WHERE relnamespace IN (SELECT oid FROM user_namespaces)) + (SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace IN (SELECT oid FROM user_namespaces)) + (SELECT count(*) FROM pg_catalog.pg_type WHERE typnamespace IN (SELECT oid FROM user_namespaces)) + (SELECT count(*) FROM user_namespaces WHERE nspname <> 'public') + (SELECT count(*) FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql');",
    ],
    pgEnv,
  );
  if (empty !== "0") throw new Error("Restore target is not empty");
  const restore = await pgProcess(
    pgBin,
    "pg_restore",
    [
      "--no-password",
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-acl",
      `--dbname=${pgEnv.PGDATABASE}`,
      dumpPath,
    ],
    pgEnv,
  );
  restore.stream.resume();
  await restore.finished;
}

function sourceIdentity(pgEnv, endpoint, bucket) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        pgEnv.PGHOST,
        pgEnv.PGPORT,
        pgEnv.PGDATABASE,
        endpoint,
        bucket,
      ]),
    )
    .digest("hex");
}

async function approvedS3Source(env) {
  const { S3Client, ListObjectsV2Command, GetObjectCommand } =
    requireApi("@aws-sdk/client-s3");
  const endpoint = new URL(required(env, "BACKUP_S3_ENDPOINT"));
  if (
    endpoint.protocol !== "https:" ||
    !/^[a-z0-9]{20}\.storage\.supabase\.co$/.test(endpoint.hostname) ||
    endpoint.pathname !== "/storage/v1/s3" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Only the approved Supabase S3 endpoint is supported");
  const bucket = required(env, "BACKUP_S3_BUCKET");
  if (
    !PRIVATE_BUCKET.test(bucket) ||
    env.BACKUP_PRIVATE_BUCKET_CONFIRMED !==
      "BUCKET_PRIVATE_AND_BACKUP_IDENTITY_APPROVED"
  )
    throw new Error("Private bucket approval required");
  const client = new S3Client({
    endpoint: endpoint.href,
    region: required(env, "BACKUP_S3_REGION"),
    forcePathStyle: true,
    maxAttempts: 2,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: required(env, "BACKUP_S3_ACCESS_KEY_ID"),
      secretAccessKey: required(env, "BACKUP_S3_SECRET_ACCESS_KEY"),
    },
  });
  return {
    endpoint: endpoint.href,
    bucket,
    close: () => client.destroy(),
    async listObjects() {
      const items = [];
      const tokens = new Set();
      let ContinuationToken;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: "private/",
            ContinuationToken,
            MaxKeys: 1000,
          }),
          { abortSignal: AbortSignal.timeout(60_000) },
        );
        for (const item of page.Contents ?? []) {
          if (
            !item.ETag ||
            !item.LastModified ||
            Number.isNaN(item.LastModified.getTime())
          )
            throw new Error("Storage inventory lacks a stable revision");
          items.push({
            key: item.Key,
            bytes: item.Size,
            version: `${item.ETag}|${item.LastModified.toISOString()}`,
          });
        }
        if (items.length > 100_000)
          throw new Error("Object inventory exceeds approved limit");
        const next = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && (!next || tokens.has(next)))
          throw new Error("Incomplete storage inventory");
        if (next) tokens.add(next);
        ContinuationToken = next;
      } while (ContinuationToken);
      return items;
    },
    async readObject(item) {
      const etag = item.version.split("|")[0];
      if (!etag || etag === "undefined")
        throw new Error("Object version is unavailable");
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: item.key, IfMatch: etag }),
        { abortSignal: AbortSignal.timeout(60_000) },
      );
      if (
        !result.Body ||
        result.ContentLength !== item.bytes ||
        result.ETag !== etag
      )
        throw new Error("Object changed during capture");
      return {
        stream: result.Body,
        metadata: result.Metadata ?? {},
        contentType: result.ContentType ?? "application/octet-stream",
      };
    },
  };
}

export async function main(command = process.argv[2], env = process.env) {
  const key = backupKey(required(env, "BACKUP_ENCRYPTION_KEY"));
  try {
    const directory = explicitPath(required(env, "BACKUP_DIRECTORY"));
    if (command === "verify") {
      const manifest = await verifyBackup(directory, key);
      console.log(
        JSON.stringify({
          status: "verified",
          backupId: manifest.backupId,
          releaseSha: manifest.releaseSha,
          objectCount: manifest.objects.length,
        }),
      );
      return;
    }
    if (command === "backup") {
      const pgEnv = postgresEnvironment(env, "BACKUP_");
      const pgBin = required(env, "BACKUP_PG_BIN");
      await pgExecutable(pgBin, "pg_dump");
      if (
        env.BACKUP_WRITES_FROZEN !== "ALL_APPLICATION_AND_WORKER_WRITES_FROZEN"
      )
        throw new Error("Write freeze must be confirmed before network access");
      const source = await approvedS3Source(env);
      let dump;
      try {
        const result = await captureBackup({
          directory,
          key,
          sourceId: sourceIdentity(pgEnv, source.endpoint, source.bucket),
          releaseSha: required(env, "BACKUP_RELEASE_SHA"),
          migrationVersion: required(env, "BACKUP_MIGRATION_VERSION"),
          writesFrozen: env.BACKUP_WRITES_FROZEN,
          database: async () => {
            dump = await pgProcess(
              pgBin,
              "pg_dump",
              ["--format=custom", "--no-owner", "--no-acl", "--no-password"],
              pgEnv,
            );
            return dump;
          },
          listObjects: source.listObjects,
          readObject: source.readObject,
        });
        await verifyBackup(directory, key);
        console.log(JSON.stringify({ status: "complete", ...result }));
      } finally {
        dump?.cancel();
        source.close();
      }
      return;
    }
    if (command === "extract" || command === "restore-local") {
      const destination = explicitPath(required(env, "RESTORE_DIRECTORY"));
      // Validate target environment before decrypting/extracting any real data.
      let pgEnv;
      if (command === "restore-local") {
        pgEnv = postgresEnvironment(env, "RESTORE_", { restore: true });
        if (
          env.RESTORE_DATABASE_CONFIRM !==
          `RESTORE_DATABASE:${pgEnv.PGDATABASE}`
        )
          throw new Error("Database confirmation does not match");
        for (const name of ["psql", "pg_restore"])
          await pgExecutable(required(env, "BACKUP_PG_BIN"), name);
      }
      const manifest = await extractBackup({
        directory,
        destination,
        key,
        confirmation: env.RESTORE_CONFIRM,
        encryptedVolumeAcknowledgement: env.RESTORE_ENCRYPTED_VOLUME,
      });
      await compareRestoredObjects(manifest, destination);
      if (pgEnv) {
        await restoreLocalDatabase({
          pgBin: env.BACKUP_PG_BIN,
          pgEnv,
          dumpPath: path.join(destination, "database.dump"),
          confirmation: env.RESTORE_DATABASE_CONFIRM,
        });
        await writeFile(
          path.join(destination, "RESTORED_LOCAL"),
          JSON.stringify({
            backupId: manifest.backupId,
            completedAt: new Date().toISOString(),
          }),
          { flag: "wx", mode: 0o600 },
        );
      }
      console.log(
        JSON.stringify({
          status: pgEnv ? "restored-local" : "extracted-only",
          backupId: manifest.backupId,
          releaseSha: manifest.releaseSha,
          objectCount: manifest.objects.length,
        }),
      );
      return;
    }
    throw new Error(
      "Expected backup, verify, extract, or restore-local command",
    );
  } finally {
    key.fill(0);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch(() => {
    console.error(
      "Backup operation failed; no success is claimed. Inspect runner prerequisites and protected evidence. Provider details are deliberately redacted.",
    );
    process.exitCode = 1;
  });
}
