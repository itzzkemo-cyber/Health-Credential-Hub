const POSTGRES_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const MIGRATION_LOCK_NAMESPACE = 1_214_809_931;
const MIGRATION_LOCK_KEY = 1;

interface DatabaseClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
  release(): void;
}

interface DatabasePool {
  connect(): Promise<DatabaseClient>;
}

export class DatabaseRoleBoundaryError extends Error {}

export interface DatabaseRoleBoundaryConfig {
  appLogin: string;
  appDmlRole: string;
  migratorLogin: string;
  migratorDdlRole: string;
  verifyLeastPrivilege: boolean;
  ownershipMode: "dedicated" | "managed";
  blockedRoles: string[];
}

interface RoleState {
  roleName: string;
  canLogin: boolean;
  isSuperuser: boolean;
  canCreateDatabase: boolean;
  canCreateRole: boolean;
  bypassesRowLevelSecurity: boolean;
  isReplicationRole: boolean;
  isCloudSqlSuperuserMember: boolean;
}

function requireRoleIdentifier(
  value: string | undefined,
  variableName: string,
): string {
  const normalized = value?.trim();
  if (!normalized || !POSTGRES_IDENTIFIER.test(normalized)) {
    throw new DatabaseRoleBoundaryError(
      `${variableName} must be a lowercase PostgreSQL identifier`,
    );
  }
  return normalized;
}

export function readDatabaseRoleBoundaryConfig(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseRoleBoundaryConfig | null {
  const configuredValues = [
    env.APP_DATABASE_USER,
    env.APP_DATABASE_ROLE,
    env.MIGRATOR_DATABASE_USER,
    env.MIGRATOR_DATABASE_ROLE,
  ];
  const isConfigured = configuredValues.some((value) => Boolean(value?.trim()));

  if (!isConfigured && env.NODE_ENV !== "production") {
    return null;
  }

  const appLogin = requireRoleIdentifier(
    env.APP_DATABASE_USER,
    "APP_DATABASE_USER",
  );
  const appDmlRole = requireRoleIdentifier(
    env.APP_DATABASE_ROLE,
    "APP_DATABASE_ROLE",
  );
  const migratorLogin = requireRoleIdentifier(
    env.MIGRATOR_DATABASE_USER,
    "MIGRATOR_DATABASE_USER",
  );
  const migratorDdlRole = requireRoleIdentifier(
    env.MIGRATOR_DATABASE_ROLE,
    "MIGRATOR_DATABASE_ROLE",
  );
  if (
    new Set([appLogin, appDmlRole, migratorLogin, migratorDdlRole]).size !== 4
  ) {
    throw new DatabaseRoleBoundaryError(
      "Application and migration login/privilege roles must all be distinct",
    );
  }

  const verifyBoundary = env.VERIFY_DATABASE_ROLE_BOUNDARY?.trim();
  if (
    verifyBoundary &&
    verifyBoundary !== "true" &&
    verifyBoundary !== "false"
  ) {
    throw new DatabaseRoleBoundaryError(
      "VERIFY_DATABASE_ROLE_BOUNDARY must be true or false",
    );
  }

  const ownershipMode = env.DATABASE_OWNERSHIP_MODE?.trim() || "dedicated";
  if (ownershipMode !== "dedicated" && ownershipMode !== "managed") {
    throw new DatabaseRoleBoundaryError(
      "DATABASE_OWNERSHIP_MODE must be dedicated or managed",
    );
  }
  const blockedRoles = (env.DATABASE_BLOCKED_ROLES ?? "")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean)
    .map((role) => requireRoleIdentifier(role, "DATABASE_BLOCKED_ROLES"));
  if (new Set(blockedRoles).size !== blockedRoles.length) {
    throw new DatabaseRoleBoundaryError(
      "DATABASE_BLOCKED_ROLES must not contain duplicates",
    );
  }
  const boundaryRoles = new Set([
    appLogin,
    appDmlRole,
    migratorLogin,
    migratorDdlRole,
  ]);
  if (blockedRoles.some((role) => boundaryRoles.has(role))) {
    throw new DatabaseRoleBoundaryError(
      "DATABASE_BLOCKED_ROLES must not include an application or migration role",
    );
  }

  return {
    appLogin,
    appDmlRole,
    migratorLogin,
    migratorDdlRole,
    verifyLeastPrivilege: verifyBoundary === "true",
    ownershipMode,
    blockedRoles,
  };
}

export function quotePostgresIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function buildApplicationDmlStatements(
  config: DatabaseRoleBoundaryConfig,
  databaseName: string,
  includeAuditTable: boolean = true,
): string[] {
  const appLogin = quotePostgresIdentifier(config.appLogin);
  const appDmlRole = quotePostgresIdentifier(config.appDmlRole);
  const migratorLogin = quotePostgresIdentifier(config.migratorLogin);
  const database = quotePostgresIdentifier(databaseName);

  const statements = [
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${appLogin}, ${appDmlRole}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appDmlRole}`,
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${appLogin}, ${appDmlRole}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${appDmlRole}`,
    `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, ${appLogin}, ${appDmlRole}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorLogin} IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorLogin} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appDmlRole}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorLogin} IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorLogin} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${appDmlRole}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorLogin} IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
  ];
  if (config.ownershipMode === "dedicated") {
    statements.unshift(
      `REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM PUBLIC`,
      `REVOKE ALL PRIVILEGES ON DATABASE ${database} FROM ${appLogin}, ${appDmlRole}`,
      `GRANT CONNECT ON DATABASE ${database} TO ${appDmlRole}`,
      "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
      `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${appLogin}, ${appDmlRole}`,
      `GRANT USAGE ON SCHEMA public TO ${appDmlRole}`,
    );
  }
  for (const blockedRole of config.blockedRoles) {
    const role = quotePostgresIdentifier(blockedRole);
    statements.push(
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${role}`,
      `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${role}`,
      `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM ${role}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorLogin} IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM ${role}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorLogin} IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM ${role}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorLogin} IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM ${role}`,
    );
  }
  if (includeAuditTable) {
    statements.push(
      `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.audit_logs FROM ${appLogin}, ${appDmlRole}`,
      `GRANT SELECT, INSERT ON TABLE public.audit_logs TO ${appDmlRole}`,
      `REVOKE ALL PRIVILEGES ON SCHEMA drizzle FROM PUBLIC, ${appLogin}, ${appDmlRole}`,
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA drizzle FROM PUBLIC, ${appLogin}, ${appDmlRole}`,
      `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA drizzle FROM PUBLIC, ${appLogin}, ${appDmlRole}`,
      `GRANT USAGE, CREATE ON SCHEMA drizzle TO ${quotePostgresIdentifier(config.migratorDdlRole)}`,
    );
  }
  return statements;
}

async function readRoleState(
  client: DatabaseClient,
  roleName: string,
): Promise<RoleState> {
  const result = await client.query<{
    roleName: string;
    canLogin: boolean;
    isSuperuser: boolean;
    canCreateDatabase: boolean;
    canCreateRole: boolean;
    bypassesRowLevelSecurity: boolean;
    isReplicationRole: boolean;
    isCloudSqlSuperuserMember: boolean;
  }>(
    `SELECT
       role.rolname AS "roleName",
       role.rolcanlogin AS "canLogin",
       role.rolsuper AS "isSuperuser",
       role.rolcreatedb AS "canCreateDatabase",
       role.rolcreaterole AS "canCreateRole",
       role.rolbypassrls AS "bypassesRowLevelSecurity",
       role.rolreplication AS "isReplicationRole",
       EXISTS (
         SELECT 1
         FROM pg_roles cloud_sql_role
         WHERE cloud_sql_role.rolname = 'cloudsqlsuperuser'
           AND pg_has_role(role.oid, cloud_sql_role.oid, 'MEMBER')
       ) AS "isCloudSqlSuperuserMember"
     FROM pg_roles role
     WHERE role.rolname = $1`,
    [roleName],
  );
  const state = result.rows[0];
  if (!state) {
    throw new DatabaseRoleBoundaryError(
      `Required PostgreSQL role ${roleName} does not exist`,
    );
  }
  return state;
}

async function ensureNoLoginBoundaryRole(
  client: DatabaseClient,
  roleName: string,
): Promise<void> {
  const existing = await client.query<{
    canLogin: boolean;
    isSuperuser: boolean;
    canCreateDatabase: boolean;
    canCreateRole: boolean;
    bypassesRowLevelSecurity: boolean;
    isReplicationRole: boolean;
    hasParentRole: boolean;
  }>(
    `SELECT
       rolcanlogin AS "canLogin",
       rolsuper AS "isSuperuser",
       rolcreatedb AS "canCreateDatabase",
       rolcreaterole AS "canCreateRole",
       rolbypassrls AS "bypassesRowLevelSecurity",
       rolreplication AS "isReplicationRole",
       EXISTS (
         SELECT 1
         FROM pg_auth_members membership
         WHERE membership.member = pg_roles.oid
       ) AS "hasParentRole"
     FROM pg_roles
     WHERE rolname = $1`,
    [roleName],
  );
  if (!existing.rows[0]) {
    await client.query(
      `CREATE ROLE ${quotePostgresIdentifier(roleName)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    return;
  }
  const role = existing.rows[0];
  if (
    role.canLogin ||
    role.isSuperuser ||
    role.canCreateDatabase ||
    role.canCreateRole ||
    role.bypassesRowLevelSecurity ||
    role.isReplicationRole ||
    role.hasParentRole
  ) {
    throw new DatabaseRoleBoundaryError(
      `PostgreSQL boundary role ${roleName} has unsafe attributes`,
    );
  }
}

async function assertSafeNoLoginBoundaryRole(
  client: DatabaseClient,
  roleName: string,
): Promise<void> {
  const existing = await client.query<{
    canLogin: boolean;
    isSuperuser: boolean;
    canCreateDatabase: boolean;
    canCreateRole: boolean;
    bypassesRowLevelSecurity: boolean;
    isReplicationRole: boolean;
    hasParentRole: boolean;
  }>(
    `SELECT
       rolcanlogin AS "canLogin",
       rolsuper AS "isSuperuser",
       rolcreatedb AS "canCreateDatabase",
       rolcreaterole AS "canCreateRole",
       rolbypassrls AS "bypassesRowLevelSecurity",
       rolreplication AS "isReplicationRole",
       EXISTS (
         SELECT 1
         FROM pg_auth_members membership
         WHERE membership.member = pg_roles.oid
       ) AS "hasParentRole"
     FROM pg_roles
     WHERE rolname = $1`,
    [roleName],
  );
  const role = existing.rows[0];
  if (
    !role ||
    role.canLogin ||
    role.isSuperuser ||
    role.canCreateDatabase ||
    role.canCreateRole ||
    role.bypassesRowLevelSecurity ||
    role.isReplicationRole ||
    role.hasParentRole
  ) {
    throw new DatabaseRoleBoundaryError(
      `PostgreSQL boundary role ${roleName} has unsafe attributes`,
    );
  }
}

async function ensureRoleMembership(
  client: DatabaseClient,
  login: string,
  grantedRole: string,
): Promise<void> {
  const membership = await client.query<{ member: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_auth_members membership
       JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
       JOIN pg_roles member_role ON member_role.oid = membership.member
       WHERE granted_role.rolname = $1
         AND member_role.rolname = $2
     ) AS member`,
    [grantedRole, login],
  );
  if (!membership.rows[0]?.member) {
    await client.query(
      `GRANT ${quotePostgresIdentifier(grantedRole)} TO ${quotePostgresIdentifier(login)}`,
    );
  }
}

async function hasRoleMembership(
  client: DatabaseClient,
  login: string,
  grantedRole: string,
): Promise<boolean> {
  const membership = await client.query<{ member: boolean }>(
    `SELECT pg_has_role($1::name, $2::name, 'SET') AS member`,
    [login, grantedRole],
  );
  return membership.rows[0]?.member === true;
}

async function assertOnlyExpectedMembership(
  client: DatabaseClient,
  login: string,
  expectedRole: string,
): Promise<void> {
  const unexpected = await client.query<{ unexpected: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_auth_members membership
       JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
       JOIN pg_roles member_role ON member_role.oid = membership.member
       WHERE member_role.rolname = $1
         AND granted_role.rolname <> $2
     ) AS unexpected`,
    [login, expectedRole],
  );
  if (unexpected.rows[0]?.unexpected) {
    throw new DatabaseRoleBoundaryError(
      `PostgreSQL login ${login} retains an unexpected database role`,
    );
  }
}

function assertSafeLoginState(state: RoleState): void {
  if (
    !state.canLogin ||
    state.isSuperuser ||
    state.canCreateDatabase ||
    state.canCreateRole ||
    state.bypassesRowLevelSecurity ||
    state.isReplicationRole ||
    state.isCloudSqlSuperuserMember
  ) {
    throw new DatabaseRoleBoundaryError(
      `PostgreSQL login ${state.roleName} retains elevated database privileges`,
    );
  }
}

/**
 * Verify the identity used by the long-running API before it opens a socket.
 * Migrations establish grants, while this check prevents an accidentally
 * privileged DATABASE_URL from turning a configuration mistake into a public
 * superuser-backed service.
 */
export async function verifyApplicationDatabaseRoleBoundary(
  databasePool: DatabasePool,
  config: DatabaseRoleBoundaryConfig,
): Promise<void> {
  if (!config.verifyLeastPrivilege) {
    throw new DatabaseRoleBoundaryError(
      "VERIFY_DATABASE_ROLE_BOUNDARY=true is required before production startup",
    );
  }
  const client = await databasePool.connect();
  try {
    const identity = await client.query<{ currentUser: string }>(
      `SELECT current_user AS "currentUser"`,
    );
    if (identity.rows[0]?.currentUser !== config.appLogin) {
      throw new DatabaseRoleBoundaryError(
        "Application connection must authenticate as APP_DATABASE_USER",
      );
    }

    const state = await readRoleState(client, config.appLogin);
    assertSafeLoginState(state);
    if (!(await hasRoleMembership(client, config.appLogin, config.appDmlRole))) {
      throw new DatabaseRoleBoundaryError(
        "Application login is missing its DML boundary role",
      );
    }
    await assertOnlyExpectedMembership(
      client,
      config.appLogin,
      config.appDmlRole,
    );
    // The login can inherit everything granted to its DML role. Checking only
    // the login's direct memberships misses a later provider/admin role grant
    // to that boundary role, so verify the no-login role itself on every
    // production start as well as during migrations.
    await assertSafeNoLoginBoundaryRole(client, config.appDmlRole);

    // Object owners can re-grant privileges or alter/drop their objects even
    // after an ordinary REVOKE. Neither the login nor its inherited DML role
    // may own any database-local object.
    const ownership = await client.query<{ ownsObjects: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_shdepend dependency
         JOIN pg_roles owner ON owner.oid = dependency.refobjid
         JOIN pg_database current_database_row
           ON current_database_row.datname = current_database()
         WHERE dependency.refclassid = 'pg_authid'::regclass
           AND dependency.deptype = 'o'
           AND owner.rolname = ANY($1::text[])
           AND dependency.dbid = current_database_row.oid
       ) AS "ownsObjects"`,
      [[config.appLogin, config.appDmlRole]],
    );
    if (ownership.rows[0]?.ownsObjects) {
      throw new DatabaseRoleBoundaryError(
        "Application database roles must not own database objects",
      );
    }

    const privileges = await client.query<{
      canConnect: boolean;
      canCreateDatabaseObjects: boolean;
      canUsePublicSchema: boolean;
      canCreateInPublicSchema: boolean;
      canReadAudit: boolean;
      canInsertAudit: boolean;
      canUpdateAudit: boolean;
      canDeleteAudit: boolean;
    }>(
      `SELECT
         has_database_privilege(current_user, current_database(), 'CONNECT')
           AS "canConnect",
         has_database_privilege(current_user, current_database(), 'CREATE')
           AS "canCreateDatabaseObjects",
         has_schema_privilege(current_user, 'public', 'USAGE')
           AS "canUsePublicSchema",
         has_schema_privilege(current_user, 'public', 'CREATE')
           AS "canCreateInPublicSchema",
         has_table_privilege(current_user, 'public.audit_logs', 'SELECT')
           AS "canReadAudit",
         has_table_privilege(current_user, 'public.audit_logs', 'INSERT')
           AS "canInsertAudit",
         has_table_privilege(current_user, 'public.audit_logs', 'UPDATE')
           AS "canUpdateAudit",
         has_table_privilege(current_user, 'public.audit_logs', 'DELETE')
           AS "canDeleteAudit"`,
    );
    const granted = privileges.rows[0];
    if (
      !granted?.canConnect ||
      !granted.canUsePublicSchema ||
      granted.canCreateDatabaseObjects ||
      granted.canCreateInPublicSchema ||
      !granted.canReadAudit ||
      !granted.canInsertAudit ||
      granted.canUpdateAudit ||
      granted.canDeleteAudit
    ) {
      throw new DatabaseRoleBoundaryError(
        "Application database grants do not match the least-privilege boundary",
      );
    }
  } finally {
    client.release();
  }
}

async function configureRoleOwnership(
  client: DatabaseClient,
  config: DatabaseRoleBoundaryConfig,
  databaseName: string,
): Promise<void> {
  const appLogin = quotePostgresIdentifier(config.appLogin);
  const migratorLogin = quotePostgresIdentifier(config.migratorLogin);
  const migratorDdlRole = quotePostgresIdentifier(config.migratorDdlRole);
  const database = quotePostgresIdentifier(databaseName);
  await ensureNoLoginBoundaryRole(client, config.appDmlRole);
  await ensureNoLoginBoundaryRole(client, config.migratorDdlRole);
  await ensureRoleMembership(client, config.appLogin, config.appDmlRole);
  await ensureRoleMembership(
    client,
    config.migratorLogin,
    config.migratorDdlRole,
  );
  const appState = await readRoleState(client, config.appLogin);
  const migratorState = await readRoleState(client, config.migratorLogin);
  if (config.verifyLeastPrivilege) {
    assertSafeLoginState(appState);
    assertSafeLoginState(migratorState);
    await assertOnlyExpectedMembership(
      client,
      config.appLogin,
      config.appDmlRole,
    );
    await assertOnlyExpectedMembership(
      client,
      config.migratorLogin,
      config.migratorDdlRole,
    );
  }

  const outsideSharedOwnership = await client.query<{ unsafe: boolean }>(
    `SELECT
       EXISTS (
         SELECT 1
         FROM pg_database database
         JOIN pg_roles owner ON owner.oid = database.datdba
         WHERE owner.rolname = $1
           AND database.datname <> current_database()
       ) OR EXISTS (
         SELECT 1
         FROM pg_tablespace tablespace
         JOIN pg_roles owner ON owner.oid = tablespace.spcowner
         WHERE owner.rolname = $1
       ) OR EXISTS (
         SELECT 1
         FROM pg_shdepend dependency
         JOIN pg_roles owner ON owner.oid = dependency.refobjid
         JOIN pg_database current_database_row
           ON current_database_row.datname = current_database()
         WHERE dependency.refclassid = 'pg_authid'::regclass
           AND dependency.deptype = 'o'
           AND owner.rolname = $1
           AND dependency.dbid NOT IN (0, current_database_row.oid)
       ) AS unsafe`,
    [config.appLogin],
  );
  if (outsideSharedOwnership.rows[0]?.unsafe) {
    throw new DatabaseRoleBoundaryError(
      "The application role owns shared PostgreSQL objects outside the application database",
    );
  }

  const applicationOwnsObjects = await client.query<{ ownsObjects: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_shdepend dependency
       JOIN pg_roles owner ON owner.oid = dependency.refobjid
       JOIN pg_database current_database_row
         ON current_database_row.datname = current_database()
       WHERE dependency.refclassid = 'pg_authid'::regclass
         AND dependency.deptype = 'o'
         AND owner.rolname = $1
         AND dependency.dbid = current_database_row.oid
     ) AS "ownsObjects"`,
    [config.appLogin],
  );
  if (applicationOwnsObjects.rows[0]?.ownsObjects) {
    if (
      !(await hasRoleMembership(
        client,
        config.migratorLogin,
        config.appLogin,
      ))
    ) {
      throw new DatabaseRoleBoundaryError(
        "Migration login needs the temporary application-owner role before ownership can be transferred",
      );
    }
    await client.query(`REASSIGN OWNED BY ${appLogin} TO ${migratorLogin}`);
  }

  const databaseOwner = await client.query<{ owner: string }>(
    `SELECT pg_get_userbyid(database.datdba) AS owner
     FROM pg_database database
     WHERE database.datname = current_database()`,
  );
  if (
    config.ownershipMode === "managed" &&
    databaseOwner.rows[0]?.owner === config.appLogin
  ) {
    throw new DatabaseRoleBoundaryError(
      "The application login must not own the managed PostgreSQL database",
    );
  }
  if (
    config.ownershipMode === "dedicated" &&
    databaseOwner.rows[0]?.owner !== config.migratorLogin
  ) {
    await client.query(`ALTER DATABASE ${database} OWNER TO ${migratorLogin}`);
  }

  const publicSchemaOwner = await client.query<{ owner: string }>(
    `SELECT pg_get_userbyid(schema.nspowner) AS owner
     FROM pg_namespace schema
     WHERE schema.nspname = 'public'`,
  );
  if (
    config.ownershipMode === "managed" &&
    publicSchemaOwner.rows[0]?.owner === config.appLogin
  ) {
    throw new DatabaseRoleBoundaryError(
      "The application login must not own the managed public schema",
    );
  }
  if (
    config.ownershipMode === "dedicated" &&
    publicSchemaOwner.rows[0]?.owner !== config.migratorLogin
  ) {
    await client.query(`ALTER SCHEMA public OWNER TO ${migratorLogin}`);
  }

  // Drizzle keeps migration history in its own schema. Existing deployments
  // may have created it while connected as a bootstrap administrator, so move
  // that narrowly scoped schema/table to the reviewed migration login too.
  const drizzleSchema = await client.query<{ owner: string }>(
    `SELECT pg_get_userbyid(schema.nspowner) AS owner
     FROM pg_namespace schema
     WHERE schema.nspname = 'drizzle'`,
  );
  if (
    drizzleSchema.rows[0] &&
    drizzleSchema.rows[0].owner !== config.migratorLogin
  ) {
    if (config.ownershipMode === "managed") {
      throw new DatabaseRoleBoundaryError(
        "The managed drizzle schema must be owned by MIGRATOR_DATABASE_USER",
      );
    }
    await client.query(`ALTER SCHEMA drizzle OWNER TO ${migratorLogin}`);
  }
  const drizzleMigrationTable = await client.query<{ owner: string }>(
    `SELECT pg_get_userbyid(relation.relowner) AS owner
     FROM pg_class relation
     JOIN pg_namespace schema ON schema.oid = relation.relnamespace
     WHERE schema.nspname = 'drizzle'
       AND relation.relname = '__drizzle_migrations'
       AND relation.relkind IN ('r', 'p')`,
  );
  if (
    drizzleMigrationTable.rows[0] &&
    drizzleMigrationTable.rows[0].owner !== config.migratorLogin
  ) {
    if (config.ownershipMode === "managed") {
      throw new DatabaseRoleBoundaryError(
        "The managed migration table must be owned by MIGRATOR_DATABASE_USER",
      );
    }
    await client.query(
      `ALTER TABLE drizzle.__drizzle_migrations OWNER TO ${migratorLogin}`,
    );
  }

  if (config.ownershipMode === "managed") {
    const managedPrivileges = await client.query<{
      canConnect: boolean;
      canCreateDatabaseObjects: boolean;
      canUsePublicSchema: boolean;
      canCreateInPublicSchema: boolean;
    }>(
      `SELECT
         has_database_privilege(current_user, current_database(), 'CONNECT') AS "canConnect",
         has_database_privilege(current_user, current_database(), 'CREATE') AS "canCreateDatabaseObjects",
         has_schema_privilege(current_user, 'public', 'USAGE') AS "canUsePublicSchema",
         has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreateInPublicSchema"`,
    );
    const privileges = managedPrivileges.rows[0];
    if (
      !privileges?.canConnect ||
      !privileges.canCreateDatabaseObjects ||
      !privileges.canUsePublicSchema ||
      !privileges.canCreateInPublicSchema
    ) {
      throw new DatabaseRoleBoundaryError(
        "Managed PostgreSQL must pre-provision migration database and schema privileges",
      );
    }
  } else {
    await client.query(
      `GRANT CONNECT, CREATE ON DATABASE ${database} TO ${migratorDdlRole}`,
    );
    await client.query(
      "GRANT USAGE, CREATE ON SCHEMA public TO " + migratorDdlRole,
    );
  }
  if (drizzleSchema.rows[0]) {
    await client.query(
      "GRANT USAGE, CREATE ON SCHEMA drizzle TO " + migratorDdlRole,
    );
  }
}

async function applyApplicationDmlBoundary(
  client: DatabaseClient,
  config: DatabaseRoleBoundaryConfig,
  databaseName: string,
  includeAuditTable: boolean = true,
): Promise<void> {
  for (const statement of buildApplicationDmlStatements(
    config,
    databaseName,
    includeAuditTable,
  )) {
    await client.query(statement);
  }
}

export async function runMigrationWithRoleBoundary(
  databasePool: DatabasePool,
  config: DatabaseRoleBoundaryConfig,
  runMigration: () => Promise<void>,
): Promise<void> {
  const client = await databasePool.connect();
  let lockAcquired = false;
  try {
    const identity = await client.query<{
      currentUser: string;
      databaseName: string;
    }>(
      `SELECT current_user AS "currentUser", current_database() AS "databaseName"`,
    );
    const currentUser = identity.rows[0]?.currentUser;
    const databaseName = identity.rows[0]?.databaseName;
    if (!currentUser || !databaseName || currentUser !== config.migratorLogin) {
      throw new DatabaseRoleBoundaryError(
        "Migration connection must authenticate as MIGRATOR_DATABASE_USER",
      );
    }

    const lock = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1, $2) AS acquired`,
      [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY],
    );
    lockAcquired = lock.rows[0]?.acquired === true;
    if (!lockAcquired) {
      throw new DatabaseRoleBoundaryError(
        "Another database migration or role-boundary operation is already running",
      );
    }

    await client.query("BEGIN");
    try {
      await configureRoleOwnership(client, config, databaseName);
      // A fresh database may not have audit_logs until the migration below.
      await applyApplicationDmlBoundary(client, config, databaseName, false);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    await runMigration();

    await client.query("BEGIN");
    try {
      await applyApplicationDmlBoundary(client, config, databaseName);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    if (lockAcquired) {
      await client
        .query(`SELECT pg_advisory_unlock($1, $2)`, [
          MIGRATION_LOCK_NAMESPACE,
          MIGRATION_LOCK_KEY,
        ])
        .catch(() => undefined);
    }
    client.release();
  }
}
