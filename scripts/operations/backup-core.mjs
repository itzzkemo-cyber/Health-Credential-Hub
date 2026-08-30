import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("HCHBK001");
const HEADER_BYTES = MAGIC.length + 12;
const TAG_BYTES = 16;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_DATABASE_BYTES = 100 * 1024 * 1024 * 1024;
const MAX_OBJECTS = 100_000;
const COMPLETE = "HCH-BACKUP-V1\n";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

export function backupKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error(
      "BACKUP_ENCRYPTION_KEY must be a canonical Base64 32-byte random key",
    );
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value)
    throw new Error("Invalid encryption key");
  return key;
}

export function validateObjectKey(key) {
  if (
    typeof key !== "string" ||
    key.length > 1024 ||
    !key.startsWith("private/")
  )
    throw new Error("Unsafe object key");
  const segments = key.split("/");
  if (
    segments.some(
      (part) =>
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
    )
  )
    throw new Error("Unsafe object key");
  // Filesystem restore reserves these sidecars for authenticated custom metadata.
  if (key.endsWith(".metadata.json")) throw new Error("Reserved object key");
  return key;
}

export function explicitPath(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value !== value.trim() ||
    /[\x00-\x1f*?$%]/.test(value)
  )
    throw new Error("An explicit absolute path is required");
  const resolved = path.resolve(value);
  if (
    resolved !== path.normalize(value) ||
    value.split(/[\\/]/).some((part) => part === ".." || part === ".")
  )
    throw new Error("Unresolved path refused");
  const forbidden = [
    path.parse(resolved).root,
    homedir(),
    process.cwd(),
    path.dirname(homedir()),
  ];
  if (
    forbidden.some(
      (entry) => path.resolve(entry).toLowerCase() === resolved.toLowerCase(),
    )
  )
    throw new Error("Broad target path refused");
  return resolved;
}

export async function noSymlinks(value, { allowMissingLeaf = false } = {}) {
  const target = explicitPath(value);
  const parsed = path.parse(target);
  let current = parsed.root;
  const pieces = target
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  for (let index = 0; index < pieces.length; index++) {
    current = path.join(current, pieces[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (
        allowMissingLeaf &&
        index === pieces.length - 1 &&
        error.code === "ENOENT"
      )
        return target;
      throw new Error("Path is absent or inaccessible");
    }
    if (
      info.isSymbolicLink() ||
      (!info.isDirectory() && index !== pieces.length - 1)
    )
      throw new Error("Symlink or non-directory ancestor refused");
    if (info.isFile() && info.nlink !== 1)
      throw new Error("Hard-linked input refused");
  }
  return target;
}

async function newPrivateDirectory(target) {
  await noSymlinks(target, { allowMissingLeaf: true });
  await mkdir(target, { mode: 0o700 }); // No recursive creation and no reuse.
}

function digestTransform(limit) {
  const hash = createHash("sha256");
  let size = 0;
  return {
    stream: new Transform({
      transform(chunk, _encoding, done) {
        size += chunk.length;
        if (size > limit) return done(new Error("Archive entry exceeds limit"));
        hash.update(chunk);
        done(null, chunk);
      },
    }),
    result: () => ({ bytes: size, sha256: hash.digest("hex") }),
  };
}

async function encryptEntry(source, target, key, aad, limit) {
  await noSymlinks(target, { allowMissingLeaf: true });
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const digest = digestTransform(limit);
  const handle = await open(
    target,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.write(Buffer.concat([MAGIC, nonce]));
    await pipeline(
      source,
      digest.stream,
      cipher,
      createWriteStream(target, {
        fd: handle.fd,
        autoClose: false,
        start: HEADER_BYTES,
      }),
    );
    const result = digest.result();
    await handle.write(
      cipher.getAuthTag(),
      0,
      TAG_BYTES,
      HEADER_BYTES + result.bytes,
    );
    await handle.sync();
    return result;
  } finally {
    await handle.close();
  }
}

async function decryptEntry(source, key, aad, limit, sink) {
  await noSymlinks(source);
  const handle = await open(
    source,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size < HEADER_BYTES + TAG_BYTES ||
      info.size > limit + HEADER_BYTES + TAG_BYTES
    )
      throw new Error("Invalid encrypted entry size");
    const header = Buffer.alloc(HEADER_BYTES);
    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(header, 0, HEADER_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, info.size - TAG_BYTES);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC))
      throw new Error("Invalid backup format");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      header.subarray(MAGIC.length),
    );
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    const digest = digestTransform(limit);
    const encryptedBytes = info.size - HEADER_BYTES - TAG_BYTES;
    const input = encryptedBytes
      ? createReadStream(source, {
          fd: handle.fd,
          autoClose: false,
          start: HEADER_BYTES,
          end: info.size - TAG_BYTES - 1,
        })
      : Readable.from([]);
    await pipeline(input, decipher, digest.stream, sink);
    return digest.result();
  } finally {
    await handle.close();
  }
}

const discard = () =>
  new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
function metadataCheck(metadata) {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.entries(metadata).some(
      ([key, value]) =>
        typeof value !== "string" ||
        key.length > 256 ||
        /[\x00-\x1f]/.test(key),
    ) ||
    Buffer.byteLength(JSON.stringify(metadata)) > 16_384
  )
    throw new Error("Invalid custom object metadata");
  const acl = metadata["acl-policy"] ?? metadata["custom:aclPolicy"];
  if (acl && JSON.parse(acl)?.visibility !== "private")
    throw new Error("Non-private object ACL refused");
  return metadata;
}

function inventoryCheck(items) {
  if (!Array.isArray(items) || items.length > MAX_OBJECTS)
    throw new Error("Invalid object inventory");
  const seen = new Set();
  return items
    .map((item) => {
      const key = validateObjectKey(item.key);
      if (
        seen.has(key) ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 0 ||
        item.bytes > MAX_OBJECT_BYTES ||
        typeof item.version !== "string" ||
        !item.version ||
        item.version.length > 256
      )
        throw new Error("Invalid object inventory item");
      seen.add(key);
      return { key, bytes: item.bytes, version: item.version };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Adapter entry point; production CLI supplies pg_dump and the approved S3 client. */
export async function captureBackup({
  directory,
  key,
  releaseSha,
  migrationVersion,
  sourceId,
  writesFrozen,
  database,
  listObjects,
  readObject,
}) {
  if (writesFrozen !== "ALL_APPLICATION_AND_WORKER_WRITES_FROZEN")
    throw new Error("Write-freeze acknowledgement required");
  if (
    !Buffer.isBuffer(key) ||
    key.length !== 32 ||
    !/^[0-9a-f]{40}$/.test(releaseSha) ||
    !HASH.test(sourceId) ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(migrationVersion)
  )
    throw new Error("Invalid backup provenance");
  const target = explicitPath(directory);
  const startedAt = new Date().toISOString();
  const before = inventoryCheck(await listObjects());
  await newPrivateDirectory(target);
  const backupId = randomUUID();
  const dbBlob = `${randomUUID()}.aead`;
  const dbSource = await database();
  const encryptingDatabase = encryptEntry(
    dbSource.stream,
    path.join(target, dbBlob),
    key,
    `${backupId}:database`,
    MAX_DATABASE_BYTES,
  );
  let dbDigest;
  try {
    [dbDigest] = await Promise.all([encryptingDatabase, dbSource.finished]);
  } catch (error) {
    dbSource.cancel?.();
    dbSource.stream.destroy();
    await encryptingDatabase.catch(() => {});
    throw error;
  } // A failed pg_dump must never receive a COMPLETE marker.
  if (dbDigest.bytes === 0) throw new Error("Empty database dump refused");
  const objects = [];
  for (const item of before) {
    const source = await readObject(item);
    const metadata = metadataCheck(source.metadata ?? {});
    if (
      typeof source.contentType !== "string" ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(source.contentType)
    )
      throw new Error("Invalid object content type");
    const blob = `${randomUUID()}.aead`;
    const digest = await encryptEntry(
      source.stream,
      path.join(target, blob),
      key,
      `${backupId}:object:${item.key}`,
      MAX_OBJECT_BYTES,
    );
    if (digest.bytes !== item.bytes)
      throw new Error("Object changed during backup");
    objects.push({
      key: item.key,
      blob,
      contentType: source.contentType,
      metadata,
      ...digest,
    });
  }
  const after = inventoryCheck(await listObjects());
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("Object inventory changed; backup is incomplete");
  const manifest = {
    version: 1,
    backupId,
    sourceId,
    releaseSha,
    migrationVersion,
    startedAt,
    completedAt: new Date().toISOString(),
    database: { blob: dbBlob, ...dbDigest },
    objects,
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  await encryptEntry(
    Readable.from([bytes]),
    path.join(target, "manifest.aead"),
    key,
    "health-credential-backup:manifest:v1",
    MAX_MANIFEST_BYTES,
  );
  await writeFile(path.join(target, "COMPLETE"), COMPLETE, {
    flag: "wx",
    mode: 0o600,
  });
  return {
    backupId,
    releaseSha,
    objectCount: objects.length,
    databaseBytes: dbDigest.bytes,
    objectBytes: objects.reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

function validateManifest(manifest) {
  if (
    manifest?.version !== 1 ||
    !UUID.test(manifest.backupId) ||
    !HASH.test(manifest.sourceId) ||
    !/^[0-9a-f]{40}$/.test(manifest.releaseSha) ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(manifest.migrationVersion) ||
    !Array.isArray(manifest.objects) ||
    manifest.objects.length > MAX_OBJECTS
  )
    throw new Error("Invalid backup manifest");
  const blobs = new Set(["manifest.aead", "COMPLETE"]);
  const keys = new Set();
  for (const [index, entry] of [
    manifest.database,
    ...manifest.objects,
  ].entries()) {
    if (
      !entry ||
      !UUID.test(entry.blob?.replace(/\.aead$/, "")) ||
      !entry.blob.endsWith(".aead") ||
      blobs.has(entry.blob) ||
      !HASH.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > (index === 0 ? MAX_DATABASE_BYTES : MAX_OBJECT_BYTES)
    )
      throw new Error("Invalid manifest entry");
    blobs.add(entry.blob);
    if (index > 0) {
      validateObjectKey(entry.key);
      if (
        keys.has(entry.key) ||
        typeof entry.contentType !== "string" ||
        !/^[\w.+-]+\/[\w.+-]+$/.test(entry.contentType)
      )
        throw new Error("Duplicate or invalid object");
      keys.add(entry.key);
      metadataCheck(entry.metadata);
    }
  }
  return blobs;
}

/** Authenticate EVERY entry before extraction or any PostgreSQL invocation. */
export async function verifyBackup(directory, key) {
  const target = await noSymlinks(directory);
  await noSymlinks(path.join(target, "COMPLETE"));
  const marker = await lstat(path.join(target, "COMPLETE"));
  if (
    !marker.isFile() ||
    marker.size !== COMPLETE.length ||
    (await readFile(path.join(target, "COMPLETE"), "utf8")) !== COMPLETE
  )
    throw new Error("Backup is incomplete");
  const chunks = [];
  await decryptEntry(
    path.join(target, "manifest.aead"),
    key,
    "health-credential-backup:manifest:v1",
    MAX_MANIFEST_BYTES,
    new Writable({
      write(chunk, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    }),
  );
  const manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const blobs = validateManifest(manifest);
  const files = await readdir(target);
  if (files.length !== blobs.size || files.some((entry) => !blobs.has(entry)))
    throw new Error("Unexpected or missing backup files");
  for (const [index, entry] of [
    manifest.database,
    ...manifest.objects,
  ].entries()) {
    const aad =
      index === 0
        ? `${manifest.backupId}:database`
        : `${manifest.backupId}:object:${entry.key}`;
    const digest = await decryptEntry(
      path.join(target, entry.blob),
      key,
      aad,
      index === 0 ? MAX_DATABASE_BYTES : MAX_OBJECT_BYTES,
      discard(),
    );
    if (digest.bytes !== entry.bytes || digest.sha256 !== entry.sha256)
      throw new Error("Backup checksum mismatch");
  }
  return manifest;
}

/** Restores only a NEW explicit local tree, never a cloud destination. */
export async function extractBackup({
  directory,
  destination,
  key,
  confirmation,
  encryptedVolumeAcknowledgement,
}) {
  const target = explicitPath(destination);
  if (
    confirmation !== `RESTORE_ISOLATED:${target}` ||
    encryptedVolumeAcknowledgement !== "ISOLATED_ENCRYPTED_VOLUME_APPROVED"
  )
    throw new Error("Isolated encrypted destination acknowledgement required");
  const manifest = await verifyBackup(directory, key);
  await newPrivateDirectory(target);
  await mkdir(path.join(target, "objects"), { mode: 0o700 });
  for (const [index, entry] of [
    manifest.database,
    ...manifest.objects,
  ].entries()) {
    const output =
      index === 0
        ? path.join(target, "database.dump")
        : path.join(target, "objects", ...entry.key.split("/"));
    if (index > 0)
      await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    await noSymlinks(output, { allowMissingLeaf: true });
    const aad =
      index === 0
        ? `${manifest.backupId}:database`
        : `${manifest.backupId}:object:${entry.key}`;
    const digest = await decryptEntry(
      path.join(directory, entry.blob),
      key,
      aad,
      index === 0 ? MAX_DATABASE_BYTES : MAX_OBJECT_BYTES,
      createWriteStream(output, { flags: "wx", mode: 0o600 }),
    );
    if (digest.sha256 !== entry.sha256 || digest.bytes !== entry.bytes)
      throw new Error("Extraction verification failed");
    if (index > 0)
      await writeFile(
        `${output}.metadata.json`,
        JSON.stringify({
          contentType: entry.contentType,
          metadata: entry.metadata,
        }),
        { flag: "wx", mode: 0o600 },
      );
  }
  await writeFile(
    path.join(target, "EXTRACTED"),
    JSON.stringify({
      backupId: manifest.backupId,
      releaseSha: manifest.releaseSha,
      objectCount: manifest.objects.length,
    }),
    { flag: "wx", mode: 0o600 },
  );
  return manifest;
}

export async function compareRestoredObjects(manifest, destination) {
  for (const entry of manifest.objects) {
    const output = await noSymlinks(
      path.join(explicitPath(destination), "objects", ...entry.key.split("/")),
    );
    const digest = digestTransform(MAX_OBJECT_BYTES);
    await pipeline(createReadStream(output), digest.stream, discard());
    const actual = digest.result();
    await noSymlinks(`${output}.metadata.json`);
    const meta = JSON.parse(await readFile(`${output}.metadata.json`, "utf8"));
    if (
      actual.bytes !== entry.bytes ||
      actual.sha256 !== entry.sha256 ||
      meta.contentType !== entry.contentType ||
      JSON.stringify(meta.metadata) !== JSON.stringify(entry.metadata)
    )
      throw new Error("Restored object or ACL metadata mismatch");
  }
  return manifest.objects.length;
}
