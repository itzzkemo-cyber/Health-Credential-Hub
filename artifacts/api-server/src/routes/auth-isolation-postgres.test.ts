/** Opt-in REAL PostgreSQL + HTTP drill. No mocks, provider credentials or .env.
 * HCH_AUTH_POSTGRES_DRILL=true enables a new disposable loopback cluster only.
 * This exercises route/session/SQL boundaries, not deployed UI or cloud storage.
 */
import { test, expect } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  rm,
  lstat,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import * as OTPAuth from "otpauth";

test.skipIf(process.env.HCH_AUTH_POSTGRES_DRILL !== "true")(
  "real PostgreSQL login/MFA, delegated admin, replay and two-facility isolation",
  async () => {
    const repo = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../..",
    );
    const local = path.join(repo, ".local");
    const pgBin =
      process.env.HCH_AUTH_DRILL_PG_BIN ??
      path.join(local, "postgresql16-portable/pgsql/bin");
    if (
      !path.isAbsolute(pgBin) ||
      path.resolve(pgBin) !== path.normalize(pgBin)
    )
      throw new Error("Explicit PostgreSQL bin path required");
    for (let ancestor = pgBin; ; ancestor = path.dirname(ancestor)) {
      if ((await lstat(ancestor)).isSymbolicLink())
        throw new Error("Symlink PostgreSQL path refused");
      if (ancestor === path.dirname(ancestor)) break;
    }
    await mkdir(local, { recursive: true });
    if ((await lstat(local)).isSymbolicLink())
      throw new Error("Unsafe fixture parent");
    const base = await mkdtemp(path.join(local, "auth-drill-"));
    const data = path.join(base, "pgdata");
    const dbPassword = randomBytes(32).toString("hex");
    const passwordFile = path.join(base, "fixture-password");
    await writeFile(passwordFile, dbPassword, { flag: "wx", mode: 0o600 });
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const pgEnv: NodeJS.ProcessEnv = {};
    for (const name of [
      "PATH",
      "SystemRoot",
      "SYSTEMROOT",
      "WINDIR",
      "TEMP",
      "TMP",
    ])
      if (process.env[name]) pgEnv[name] = process.env[name];
    Object.assign(pgEnv, {
      PGHOST: "127.0.0.1",
      PGPORT: String(port),
      PGDATABASE: "postgres",
      PGUSER: "fixture_admin",
      PGPASSWORD: dbPassword,
      PGSSLMODE: "disable",
    });
    const tool = async (name: string, args: string[]) => {
      if (!["initdb", "pg_ctl", "psql"].includes(name))
        throw new Error("Unapproved tool");
      const executable = path.join(
        pgBin,
        name + (process.platform === "win32" ? ".exe" : ""),
      );
      const executableInfo = await lstat(executable);
      if (!executableInfo.isFile() || executableInfo.isSymbolicLink())
        throw new Error("Unsafe PostgreSQL executable");
      return new Promise<void>((resolve, reject) => {
        const child = spawn(
          path.join(pgBin, name + (process.platform === "win32" ? ".exe" : "")),
          args,
          { env: pgEnv, shell: false, windowsHide: true, stdio: "ignore" },
        );
        const timer = setTimeout(() => child.kill(), 30_000);
        child.once("error", () => {
          clearTimeout(timer);
          reject(new Error("Fixture PostgreSQL failed to start"));
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          code === 0 ? resolve() : reject(new Error(`Fixture ${name} failed`));
        });
      });
    };
    let started = false;
    let server: ReturnType<typeof express.application.listen> | undefined;
    let pool: (typeof import("@workspace/db"))["pool"] | undefined;
    const saved = { ...process.env };
    try {
      await tool("initdb", [
        "-D",
        data,
        "--encoding=UTF8",
        "--locale=C",
        "--username=fixture_admin",
        "--auth-host=scram-sha-256",
        "--auth-local=scram-sha-256",
        `--pwfile=${passwordFile}`,
      ]);
      await rm(passwordFile);
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
      await tool("psql", [
        "-X",
        "-w",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "CREATE DATABASE hch_auth_fixture",
      ]);
      pgEnv.PGDATABASE = "hch_auth_fixture";
      const journal = JSON.parse(
        await readFile(
          path.join(repo, "lib/db/migrations/meta/_journal.json"),
          "utf8",
        ),
      );
      for (const entry of journal.entries)
        await tool("psql", [
          "-X",
          "-w",
          "-v",
          "ON_ERROR_STOP=1",
          "-f",
          path.join(repo, "lib/db/migrations", `${entry.tag}.sql`),
        ]);
      // Remove inherited provider/Node credentials before loading ANY app module.
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, {
        NODE_ENV: "test",
        DATABASE_URL: `postgresql://fixture_admin:${dbPassword}@127.0.0.1:${port}/hch_auth_fixture`,
        SESSION_SECRET: randomBytes(48).toString("hex"),
        TOTP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        OBJECT_STORAGE_PROVIDER: "filesystem",
        LOCAL_OBJECT_STORAGE_DIR: path.join(base, "objects"),
        PRIVATE_OBJECT_DIR: "/fixture/private",
        LOG_LEVEL: "silent",
      });
      pool = (await import("@workspace/db")).pool;
      const { hashPassword } = await import("../lib/auth");
      const { encryptTotpSecret } = await import("../lib/totpSecret");
      const { generateBackupCodes } = await import("../lib/totp");
      const secret = new OTPAuth.Secret({ size: 20 });
      const otp = new OTPAuth.TOTP({
        secret,
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      });
      const backups = generateBackupCodes();
      const password = randomBytes(20).toString("hex");
      const hash = await hashPassword(password);
      await pool.query(
        "INSERT INTO facilities(name,name_ar) VALUES ('Fixture A','A'),('Fixture B','B')",
      );
      await pool.query(
        "INSERT INTO users(email,password_hash,name,name_ar,role,facility_id,totp_enabled,totp_secret,backup_codes) VALUES ($1,$2,'Root','Root','system_admin',1,true,$3,$4)",
        [
          "root@example.invalid",
          hash,
          encryptTotpSecret(secret.base32),
          JSON.stringify(backups.hashes),
        ],
      );
      await pool.query(
        "INSERT INTO users(email,password_hash,name,name_ar,role,facility_id) VALUES ('employee-a@example.invalid',$1,'A','A','employee',1),('employee-b@example.invalid',$1,'B','B','employee',2)",
        [hash],
      );
      await pool.query(
        "INSERT INTO credentials(employee_id,type,holder_name,holder_name_ar,issuer_name,issuer_name_ar,certificate_number,issue_date,expiry_date,qr_token) VALUES (2,'BLS','A','A','I','I','A','2026-01-01','2028-01-01','fixture-a'),(3,'BLS','B','B','I','I','B','2026-01-01','2028-01-01','fixture-b')",
      );
      const objectDirectory = path.join(
        base,
        "objects/fixture/private/uploads",
      );
      await mkdir(objectDirectory, { recursive: true });
      const fixtureBytes = Buffer.from(
        "Synthetic private document bytes; not an upload-parser test",
      );
      const objectIds = [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ];
      for (const [index, id] of objectIds.entries()) {
        const objectPath = path.join(objectDirectory, id);
        await writeFile(objectPath, fixtureBytes, { flag: "wx", mode: 0o600 });
        await writeFile(
          `${objectPath}.metadata.json`,
          JSON.stringify({
            contentType: "application/pdf",
            metadata: {
              "acl-policy": JSON.stringify({
                owner: String(index + 2),
                visibility: "private",
              }),
            },
          }),
          { flag: "wx", mode: 0o600 },
        );
        await pool.query(
          "UPDATE credentials SET file_url=$1,file_type='application/pdf' WHERE id=$2",
          [`/objects/uploads/${id}`, index + 1],
        );
      }
      const app = express();
      app.set("trust proxy", "loopback");
      app.use(express.json(), cookieParser());
      app.use((await import("../lib/csrf")).csrfOriginGuard);
      app.use(
        (await import("./auth")).default,
        (await import("./employees")).default,
        (await import("./credentials")).default,
        (await import("./storage")).default,
        (await import("./schedules")).default,
      );
      // Keep fixture failures private, just as production's error envelope does.
      app.use(
        (
          _error: unknown,
          _req: express.Request,
          res: express.Response,
          _next: express.NextFunction,
        ) => {
          res.status(500).json({ message: "Fixture server error" });
        },
      );
      server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server!.once("listening", resolve));
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const fixtureAddresses = new Map<string, string>();
      const call = (
        url: string,
        cookie = "",
        body?: unknown,
        method = body ? "POST" : "GET",
      ) => {
        // Independent fixture identities simulate separate client addresses;
        // keep the real per-source limiter enabled throughout this drill.
        if (!fixtureAddresses.has(cookie))
          fixtureAddresses.set(cookie, `192.0.2.${fixtureAddresses.size + 1}`);
        return fetch(origin + url, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "HealthCredentialHub",
            Origin: origin,
            "X-Forwarded-For": fixtureAddresses.get(cookie)!,
            ...(cookie ? { Cookie: cookie } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      };
      const cookieOf = (response: Response) =>
        response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      const login = await call("/auth/login", "", {
        email: "root@example.invalid",
        password,
      });
      expect(login.status).toBe(202);
      expect(cookieOf(login)).toBe("");
      const challenge = (await login.json()) as { challengeToken: string };
      expect((await call("/employees")).status).toBe(401);
      const mfa = await call("/auth/totp/challenge", "", {
        ...challenge,
        code: otp.generate(),
      });
      expect(mfa.status).toBe(200);
      const rootCookie = cookieOf(mfa);
      expect(rootCookie).not.toBe("");
      expect(
        (
          await call("/auth/totp/challenge", "", {
            ...challenge,
            code: otp.generate(),
          })
        ).status,
      ).toBe(401);
      const create = {
        name: "Delegated",
        nameAr: "Delegated",
        email: "manager@example.invalid",
        password,
        role: "hospital_admin",
        jobTitle: "Manager",
        jobTitleAr: "Manager",
        employeeNumber: "FIX-M",
        facilityId: 1,
        currentPassword: password,
        code: backups.plaintext[0],
      };
      const delegated = await call("/employees", rootCookie, create);
      expect(delegated.status).toBe(201);
      const row = (
        await pool.query(
          "SELECT role,facility_id,must_change_password FROM users WHERE email='manager@example.invalid'",
        )
      ).rows[0];
      expect(row).toEqual({
        role: "hospital_admin",
        facility_id: 1,
        must_change_password: true,
      });
      expect(
        (
          await pool.query(
            "SELECT jsonb_array_length(backup_codes) n FROM users WHERE id=1",
          )
        ).rows[0].n,
      ).toBe(7);
      const newManagerLogin = await call("/auth/login", "", {
        email: "manager@example.invalid",
        password,
      });
      expect(newManagerLogin.status).toBe(200);
      expect((await call("/employees", cookieOf(newManagerLogin))).status).toBe(
        403,
      );
      expect(
        (
          await call("/employees", rootCookie, {
            ...create,
            email: "replay@example.invalid",
            employeeNumber: "FIX-R",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM users WHERE email='replay@example.invalid'",
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await call(
            "/employees/1",
            rootCookie,
            { role: "system_admin", facilityId: 2 },
            "PATCH",
          )
        ).status,
      ).toBe(403);
      const employeeLogin = await call("/auth/login", "", {
        email: "employee-a@example.invalid",
        password,
      });
      expect(employeeLogin.status).toBe(200);
      const employeeCookie = cookieOf(employeeLogin);
      const list = await call("/credentials", employeeCookie);
      expect(list.status).toBe(200);
      const listed = (await list.json()) as {
        data: Array<{ employeeId: number }>;
      };
      expect(listed.data.map((item) => item.employeeId)).toEqual([2]);
      const ownedDocument = await call(
        `/storage/objects/uploads/${objectIds[0]}`,
        employeeCookie,
      );
      expect(ownedDocument.status).toBe(200);
      expect(
        Buffer.from(await ownedDocument.arrayBuffer()).equals(fixtureBytes),
      ).toBe(true);
      expect(ownedDocument.headers.get("cache-control")).toContain("no-store");
      expect(
        (await call(`/storage/objects/uploads/${objectIds[1]}`, employeeCookie))
          .status,
      ).toBe(404);
      expect(
        (await call(`/storage/objects/uploads/${objectIds[0]}`)).status,
      ).toBe(401);
      expect(
        (await call(`/storage/objects/uploads/${objectIds[1]}`, rootCookie))
          .status,
      ).toBe(200);
      expect((await call("/credentials/1", employeeCookie)).status).toBe(200);
      expect((await call("/credentials/2", employeeCookie)).status).toBe(404);
      expect(
        (
          await call(
            "/employees/2",
            employeeCookie,
            { role: "system_admin" },
            "PATCH",
          )
        ).status,
      ).toBe(403);
      expect((await call("/employees", employeeCookie, create)).status).toBe(
        403,
      );
      await (
        await import("../test-support/schedulesPostgresDrill")
      ).runSchedulesPostgresDrill(pool, call, rootCookie);
      await pool.query(
        "UPDATE users SET session_version=session_version+1 WHERE id=2",
      );
      expect((await call("/credentials", employeeCookie)).status).toBe(401);
      expect(
        (await pool.query("SELECT count(*)::int n FROM audit_logs")).rows[0].n,
      ).toBeGreaterThan(0);
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await pool?.end();
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
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
      if (
        path.dirname(base) !== local ||
        !path.basename(base).startsWith("auth-drill-") ||
        (await lstat(base)).isSymbolicLink()
      )
        throw new Error("Unsafe cleanup");
      await rm(base, { recursive: true, maxRetries: 10, retryDelay: 200 });
    }
  },
  120_000,
);
