import { describe, expect, it, vi } from "vitest";
import {
  buildApplicationDmlStatements,
  quotePostgresIdentifier,
  readDatabaseRoleBoundaryConfig,
  runMigrationWithRoleBoundary,
  verifyApplicationDatabaseRoleBoundary,
} from "./databaseRoleBoundary";

const config = {
  appLogin: "healthdocs_app",
  appDmlRole: "healthdocs_app_dml",
  migratorLogin: "healthdocs_migrator",
  migratorDdlRole: "healthdocs_migrator_ddl",
  verifyLeastPrivilege: false,
  ownershipMode: "dedicated" as const,
  blockedRoles: [],
};

describe("database migration role boundary", () => {
  it("requires distinct, safe role identifiers in production", () => {
    expect(() =>
      readDatabaseRoleBoundaryConfig({ NODE_ENV: "production" }),
    ).toThrow(/APP_DATABASE_USER/);
    expect(() =>
      readDatabaseRoleBoundaryConfig({
        NODE_ENV: "production",
        APP_DATABASE_USER: "healthdocs_app;DROP ROLE postgres",
        APP_DATABASE_ROLE: "healthdocs_app_dml",
        MIGRATOR_DATABASE_USER: "healthdocs_migrator",
        MIGRATOR_DATABASE_ROLE: "healthdocs_migrator_ddl",
      }),
    ).toThrow(/lowercase PostgreSQL identifier/);
    expect(() =>
      readDatabaseRoleBoundaryConfig({
        NODE_ENV: "production",
        APP_DATABASE_USER: "healthdocs_app",
        APP_DATABASE_ROLE: "healthdocs_app",
        MIGRATOR_DATABASE_USER: "healthdocs_migrator",
        MIGRATOR_DATABASE_ROLE: "healthdocs_migrator_ddl",
      }),
    ).toThrow(/must all be distinct/);
  });

  it("keeps local migration compatibility when no boundary is configured", () => {
    expect(readDatabaseRoleBoundaryConfig({ NODE_ENV: "test" })).toBeNull();
  });

  it("enables the post-assignment privilege verification explicitly", () => {
    expect(
      readDatabaseRoleBoundaryConfig({
        NODE_ENV: "production",
        APP_DATABASE_USER: "healthdocs_app",
        APP_DATABASE_ROLE: "healthdocs_app_dml",
        MIGRATOR_DATABASE_USER: "healthdocs_migrator",
        MIGRATOR_DATABASE_ROLE: "healthdocs_migrator_ddl",
        VERIFY_DATABASE_ROLE_BOUNDARY: "true",
      })?.verifyLeastPrivilege,
    ).toBe(true);
    expect(() =>
      readDatabaseRoleBoundaryConfig({
        NODE_ENV: "production",
        APP_DATABASE_USER: "healthdocs_app",
        APP_DATABASE_ROLE: "healthdocs_app_dml",
        MIGRATOR_DATABASE_USER: "healthdocs_migrator",
        MIGRATOR_DATABASE_ROLE: "healthdocs_migrator_ddl",
        VERIFY_DATABASE_ROLE_BOUNDARY: "yes",
      }),
    ).toThrow(/must be true or false/);
  });

  it("accepts managed database ownership only when explicitly configured", () => {
    expect(
      readDatabaseRoleBoundaryConfig({
        NODE_ENV: "production",
        APP_DATABASE_USER: "healthdocs_app",
        APP_DATABASE_ROLE: "healthdocs_app_dml",
        MIGRATOR_DATABASE_USER: "healthdocs_migrator",
        MIGRATOR_DATABASE_ROLE: "healthdocs_migrator_ddl",
        DATABASE_OWNERSHIP_MODE: "managed",
      })?.ownershipMode,
    ).toBe("managed");
    expect(() =>
      readDatabaseRoleBoundaryConfig({
        NODE_ENV: "production",
        APP_DATABASE_USER: "healthdocs_app",
        APP_DATABASE_ROLE: "healthdocs_app_dml",
        MIGRATOR_DATABASE_USER: "healthdocs_migrator",
        MIGRATOR_DATABASE_ROLE: "healthdocs_migrator_ddl",
        DATABASE_OWNERSHIP_MODE: "unsafe",
      }),
    ).toThrow(/dedicated or managed/);
  });

  it("revokes table and default privileges from explicitly blocked provider roles", () => {
    const parsed = readDatabaseRoleBoundaryConfig({
      NODE_ENV: "production",
      APP_DATABASE_USER: "healthdocs_app",
      APP_DATABASE_ROLE: "healthdocs_app_dml",
      MIGRATOR_DATABASE_USER: "healthdocs_migrator",
      MIGRATOR_DATABASE_ROLE: "healthdocs_migrator_ddl",
      DATABASE_BLOCKED_ROLES: "anon,authenticated,service_role",
    });
    const statements = buildApplicationDmlStatements(
      parsed!,
      "postgres",
    ).join("\n");

    expect(parsed?.blockedRoles).toEqual([
      "anon",
      "authenticated",
      "service_role",
    ]);
    expect(statements).toContain(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM "anon"',
    );
    expect(statements).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "healthdocs_migrator" IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM "service_role"',
    );
  });

  it("builds DML-only grants and excludes schema-changing privileges", () => {
    const statements = buildApplicationDmlStatements(
      config,
      "healthdocs",
    ).join("\n");

    expect(statements).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "healthdocs_app_dml"',
    );
    expect(statements).toContain(
      'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "healthdocs_app_dml"',
    );
    expect(statements).toContain(
      'REVOKE ALL PRIVILEGES ON DATABASE "healthdocs" FROM "healthdocs_app", "healthdocs_app_dml"',
    );
    expect(statements).not.toMatch(/GRANT (CREATE|TRUNCATE|TRIGGER|REFERENCES).*healthdocs_app/);
    expect(statements).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "healthdocs_migrator"',
    );
    expect(statements).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.audit_logs FROM "healthdocs_app", "healthdocs_app_dml"',
    );
    expect(statements).toContain(
      'GRANT SELECT, INSERT ON TABLE public.audit_logs TO "healthdocs_app_dml"',
    );
    expect(statements).toContain(
      'REVOKE ALL PRIVILEGES ON SCHEMA drizzle FROM PUBLIC, "healthdocs_app", "healthdocs_app_dml"',
    );
    expect(statements).toContain(
      'GRANT USAGE, CREATE ON SCHEMA drizzle TO "healthdocs_migrator_ddl"',
    );
  });

  it("skips audit table grants before a fresh schema migration creates it", () => {
    const statements = buildApplicationDmlStatements(
      config,
      "healthdocs",
      false,
    ).join("\n");

    expect(statements).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "healthdocs_app_dml"',
    );
    expect(statements).not.toContain("public.audit_logs");
    expect(statements).not.toContain("SCHEMA drizzle");
  });

  it("leaves provider-owned database and public schema grants to managed bootstrap", () => {
    const statements = buildApplicationDmlStatements(
      { ...config, ownershipMode: "managed" },
      "postgres",
    ).join("\n");

    expect(statements).not.toContain("ON DATABASE");
    expect(statements).not.toContain("ON SCHEMA public FROM");
    expect(statements).toContain("ON ALL TABLES IN SCHEMA public");
  });

  it("quotes server-returned identifiers defensively", () => {
    expect(quotePostgresIdentifier('health"docs')).toBe('"health""docs"');
  });

  it("fails before DDL when the connection is not the migrator login", async () => {
    const migration = vi.fn();
    const release = vi.fn();
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{ currentUser: "healthdocs_app", databaseName: "healthdocs" }],
      }),
      release,
    };

    await expect(
      runMigrationWithRoleBoundary(
        { connect: async () => client },
        config,
        migration,
      ),
    ).rejects.toThrow(/must authenticate as MIGRATOR_DATABASE_USER/);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(migration).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails closed when another migration holds the advisory lock", async () => {
    const migration = vi.fn();
    const release = vi.fn();
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              currentUser: "healthdocs_migrator",
              databaseName: "healthdocs",
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ acquired: false }] }),
      release,
    };

    await expect(
      runMigrationWithRoleBoundary(
        { connect: async () => client },
        config,
        migration,
      ),
    ).rejects.toThrow(/already running/);
    expect(migration).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("refuses production startup when boundary verification is disabled", async () => {
    const connect = vi.fn();

    await expect(
      verifyApplicationDatabaseRoleBoundary(
        { connect },
        { ...config, verifyLeastPrivilege: false },
      ),
    ).rejects.toThrow(/VERIFY_DATABASE_ROLE_BOUNDARY=true/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("verifies the API login and immutable audit grants before startup", async () => {
    const release = vi.fn();
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ currentUser: config.appLogin }] })
        .mockResolvedValueOnce({
          rows: [
            {
              roleName: config.appLogin,
              canLogin: true,
              isSuperuser: false,
              canCreateDatabase: false,
              canCreateRole: false,
              bypassesRowLevelSecurity: false,
              isReplicationRole: false,
              isCloudSqlSuperuserMember: false,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ member: true }] })
        .mockResolvedValueOnce({ rows: [{ unexpected: false }] })
        .mockResolvedValueOnce({
          rows: [
            {
              canLogin: false,
              isSuperuser: false,
              canCreateDatabase: false,
              canCreateRole: false,
              bypassesRowLevelSecurity: false,
              isReplicationRole: false,
              hasParentRole: false,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ ownsObjects: false }] })
        .mockResolvedValueOnce({
          rows: [
            {
              canConnect: true,
              canCreateDatabaseObjects: false,
              canUsePublicSchema: true,
              canCreateInPublicSchema: false,
              canReadAudit: true,
              canInsertAudit: true,
              canUpdateAudit: false,
              canDeleteAudit: false,
            },
          ],
        }),
      release,
    };

    await expect(
      verifyApplicationDatabaseRoleBoundary(
        { connect: async () => client },
        { ...config, verifyLeastPrivilege: true },
      ),
    ).resolves.toBeUndefined();
    expect(client.query).toHaveBeenCalledTimes(7);
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails startup when the inherited DML role gains a parent role", async () => {
    const release = vi.fn();
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ currentUser: config.appLogin }] })
        .mockResolvedValueOnce({
          rows: [
            {
              roleName: config.appLogin,
              canLogin: true,
              isSuperuser: false,
              canCreateDatabase: false,
              canCreateRole: false,
              bypassesRowLevelSecurity: false,
              isReplicationRole: false,
              isCloudSqlSuperuserMember: false,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ member: true }] })
        .mockResolvedValueOnce({ rows: [{ unexpected: false }] })
        .mockResolvedValueOnce({
          rows: [
            {
              canLogin: false,
              isSuperuser: false,
              canCreateDatabase: false,
              canCreateRole: false,
              bypassesRowLevelSecurity: false,
              isReplicationRole: false,
              hasParentRole: true,
            },
          ],
        }),
      release,
    };

    await expect(
      verifyApplicationDatabaseRoleBoundary(
        { connect: async () => client },
        { ...config, verifyLeastPrivilege: true },
      ),
    ).rejects.toThrow(/boundary role .* unsafe attributes/);
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails startup when an application database role owns an object", async () => {
    const release = vi.fn();
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ currentUser: config.appLogin }] })
        .mockResolvedValueOnce({
          rows: [
            {
              roleName: config.appLogin,
              canLogin: true,
              isSuperuser: false,
              canCreateDatabase: false,
              canCreateRole: false,
              bypassesRowLevelSecurity: false,
              isReplicationRole: false,
              isCloudSqlSuperuserMember: false,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ member: true }] })
        .mockResolvedValueOnce({ rows: [{ unexpected: false }] })
        .mockResolvedValueOnce({
          rows: [
            {
              canLogin: false,
              isSuperuser: false,
              canCreateDatabase: false,
              canCreateRole: false,
              bypassesRowLevelSecurity: false,
              isReplicationRole: false,
              hasParentRole: false,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ ownsObjects: true }] }),
      release,
    };

    await expect(
      verifyApplicationDatabaseRoleBoundary(
        { connect: async () => client },
        { ...config, verifyLeastPrivilege: true },
      ),
    ).rejects.toThrow(/must not own database objects/);
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails startup when audit rows remain mutable", async () => {
    const release = vi.fn();
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ currentUser: config.appLogin }] })
        .mockResolvedValueOnce({
          rows: [
            {
              roleName: config.appLogin,
              canLogin: true,
              isSuperuser: false,
              canCreateDatabase: false,
              canCreateRole: false,
              bypassesRowLevelSecurity: false,
              isReplicationRole: false,
              isCloudSqlSuperuserMember: false,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ member: true }] })
        .mockResolvedValueOnce({ rows: [{ unexpected: false }] })
        .mockResolvedValueOnce({
          rows: [
            {
              canLogin: false,
              isSuperuser: false,
              canCreateDatabase: false,
              canCreateRole: false,
              bypassesRowLevelSecurity: false,
              isReplicationRole: false,
              hasParentRole: false,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ ownsObjects: false }] })
        .mockResolvedValueOnce({
          rows: [
            {
              canConnect: true,
              canCreateDatabaseObjects: false,
              canUsePublicSchema: true,
              canCreateInPublicSchema: false,
              canReadAudit: true,
              canInsertAudit: true,
              canUpdateAudit: true,
              canDeleteAudit: false,
            },
          ],
        }),
      release,
    };

    await expect(
      verifyApplicationDatabaseRoleBoundary(
        { connect: async () => client },
        { ...config, verifyLeastPrivilege: true },
      ),
    ).rejects.toThrow(/least-privilege boundary/);
    expect(release).toHaveBeenCalledOnce();
  });
});
