import pg from "pg";

const { Client } = pg;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function roleIdentifier(name: string): string {
  const value = required(name);
  if (!IDENTIFIER.test(value)) {
    throw new Error(`${name} must be a lowercase PostgreSQL identifier`);
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const connectionString = required("DATABASE_URL");
const appLogin = roleIdentifier("APP_DATABASE_USER");
const appDmlRole = roleIdentifier("APP_DATABASE_ROLE");
const migratorLogin = roleIdentifier("MIGRATOR_DATABASE_USER");
const migratorDdlRole = roleIdentifier("MIGRATOR_DATABASE_ROLE");
const appPassword = required("APP_DATABASE_PASSWORD");
const migratorPassword = required("MIGRATOR_DATABASE_PASSWORD");

if (
  new Set([appLogin, appDmlRole, migratorLogin, migratorDdlRole]).size !== 4
) {
  throw new Error("Application and migration roles must all be distinct");
}

delete process.env.APP_DATABASE_PASSWORD;
delete process.env.MIGRATOR_DATABASE_PASSWORD;

const client = new Client({ connectionString });
await client.connect();
try {
  await client.query("BEGIN");
  const existing = await client.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])",
    [[appLogin, appDmlRole, migratorLogin, migratorDdlRole]],
  );
  if (existing.rowCount) {
    throw new Error(
      "Managed database roles already exist; refusing to overwrite credentials",
    );
  }

  const appLoginSql = quoteIdentifier(appLogin);
  const appDmlRoleSql = quoteIdentifier(appDmlRole);
  const migratorLoginSql = quoteIdentifier(migratorLogin);
  const migratorDdlRoleSql = quoteIdentifier(migratorDdlRole);

  await client.query(
    `CREATE ROLE ${appDmlRoleSql} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
  );
  await client.query(
    `CREATE ROLE ${migratorDdlRoleSql} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
  );
  await client.query(
    `CREATE ROLE ${appLoginSql} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(appPassword)}`,
  );
  await client.query(
    `CREATE ROLE ${migratorLoginSql} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(migratorPassword)}`,
  );
  await client.query(`GRANT ${appDmlRoleSql} TO ${appLoginSql}`);
  await client.query(`GRANT ${migratorDdlRoleSql} TO ${migratorLoginSql}`);

  const database = await client.query<{ databaseName: string }>(
    'SELECT current_database() AS "databaseName"',
  );
  const databaseSql = quoteIdentifier(database.rows[0]!.databaseName);
  await client.query(
    `REVOKE CREATE, TEMPORARY ON DATABASE ${databaseSql} FROM PUBLIC`,
  );
  await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  await client.query(
    `REVOKE ALL PRIVILEGES ON DATABASE ${databaseSql} FROM ${appLoginSql}, ${appDmlRoleSql}`,
  );
  await client.query(
    `GRANT CONNECT ON DATABASE ${databaseSql} TO ${appDmlRoleSql}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${appLoginSql}, ${appDmlRoleSql}`,
  );
  await client.query(`GRANT USAGE ON SCHEMA public TO ${appDmlRoleSql}`);
  await client.query(
    `GRANT CONNECT, CREATE ON DATABASE ${databaseSql} TO ${migratorDdlRoleSql}`,
  );
  await client.query(
    `GRANT USAGE, CREATE ON SCHEMA public TO ${migratorDdlRoleSql}`,
  );

  const dataApiRoles = await client.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])",
    [["anon", "authenticated", "service_role"]],
  );
  for (const role of dataApiRoles.rows) {
    await client.query(
      `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${quoteIdentifier(role.rolname)}`,
    );
  }

  await client.query("COMMIT");
  console.log(
    "Managed PostgreSQL roles provisioned with isolated application and migration privileges.",
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
