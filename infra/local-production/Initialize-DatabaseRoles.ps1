[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "High")]
param(
  [Parameter(Mandatory)][string]$ConfigPath,
  [Parameter(Mandatory)][string]$SecretsPath,
  [string]$PostgresAdministrator = "postgres"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "Common.ps1")

$config = Read-LocalProductionConfig -ConfigPath $ConfigPath
$secrets = Read-LocalProductionSecrets -SecretsPath $SecretsPath
Assert-ConfigValues -Config $config
Assert-SafeIdentifier -Value $PostgresAdministrator -Label "PostgresAdministrator"
Assert-LoopbackListener -Port ([int]$config.database.port) -Label "PostgreSQL" -RequirePresent

$administratorPassword = Read-Host "Enter the PostgreSQL administrator password" -AsSecureString
$dataDirectoryParameters = @{
  Config = $config
  User = $PostgresAdministrator
  Password = $administratorPassword
  Query = "SHOW data_directory"
}
$dataDirectory = Invoke-PsqlScalar @dataDirectoryParameters
if ((Get-NormalizedPath -Path $dataDirectory) -ne (Get-NormalizedPath -Path $config.postgresDataRoot)) {
  Fail-LocalProduction "PostgreSQL data_directory does not match postgresDataRoot"
}
$postgresServiceSids = if ([string]::IsNullOrWhiteSpace([string]$config.database.windowsServiceSid)) {
  @()
} else {
  @([string]$config.database.windowsServiceSid)
}
Assert-RestrictedAcl -Path $config.postgresDataRoot -Label "PostgreSQL data directory" -AdditionalApprovedSids $postgresServiceSids
Assert-EncryptedVolume -Path $config.postgresDataRoot -Label "PostgreSQL data directory"

$appUser = [string]$config.database.appUser
$appRole = [string]$config.database.appRole
$migratorUser = [string]$config.database.migratorUser
$migratorRole = [string]$config.database.migratorRole

$sql = @"
\set ON_ERROR_STOP on
\set QUIET 1
\getenv app_password WATHAIQI_APP_DATABASE_PASSWORD
\getenv migrator_password WATHAIQI_MIGRATOR_DATABASE_PASSWORD

SELECT EXISTS (
  SELECT 1
  FROM pg_shdepend dependency
  JOIN pg_roles owner ON owner.oid = dependency.refobjid
  JOIN pg_database current_database_row ON current_database_row.datname = current_database()
  WHERE dependency.refclassid = 'pg_authid'::regclass
    AND dependency.deptype = 'o'
    AND owner.rolname IN ('$appUser', '$appRole', '$migratorUser', '$migratorRole')
    AND dependency.dbid NOT IN (0, current_database_row.oid)
) AS unsafe_external_ownership \gset
\if :unsafe_external_ownership
  \echo 'A requested role owns objects outside the application database.'
  \quit 3
\endif

BEGIN;
SET LOCAL log_statement = 'none';

SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', '$appRole')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$appRole') \gexec
SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', '$migratorRole')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$migratorRole') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT', '$appUser')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$appUser') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT', '$migratorUser')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$migratorUser') \gexec

SELECT format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', '$appRole') \gexec
SELECT format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', '$migratorRole') \gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT PASSWORD %L', '$appUser', :'app_password') \gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT PASSWORD %L', '$migratorUser', :'migrator_password') \gexec

SELECT format('REVOKE %I FROM %I', granted.rolname, member.rolname)
FROM pg_auth_members membership
JOIN pg_roles granted ON granted.oid = membership.roleid
JOIN pg_roles member ON member.oid = membership.member
WHERE member.rolname = '$appUser' AND granted.rolname <> '$appRole' \gexec
SELECT format('REVOKE %I FROM %I', granted.rolname, member.rolname)
FROM pg_auth_members membership
JOIN pg_roles granted ON granted.oid = membership.roleid
JOIN pg_roles member ON member.oid = membership.member
WHERE member.rolname = '$migratorUser' AND granted.rolname <> '$migratorRole' \gexec
SELECT format('REVOKE %I FROM %I', granted.rolname, member.rolname)
FROM pg_auth_members membership
JOIN pg_roles granted ON granted.oid = membership.roleid
JOIN pg_roles member ON member.oid = membership.member
WHERE member.rolname IN ('$appRole', '$migratorRole') \gexec
SELECT format('GRANT %I TO %I', '$appRole', '$appUser') \gexec
SELECT format('GRANT %I TO %I', '$migratorRole', '$migratorUser') \gexec

SELECT format('REASSIGN OWNED BY %I TO %I', '$appUser', '$migratorUser')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$appUser') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', current_database(), '$migratorUser') \gexec
SELECT format('ALTER SCHEMA public OWNER TO %I', '$migratorUser') \gexec
SELECT format('ALTER SCHEMA drizzle OWNER TO %I', '$migratorUser')
WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') \gexec
SELECT format('ALTER TABLE %I.%I OWNER TO %I', namespace.nspname, relation.relname, '$migratorUser')
FROM pg_class relation
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname IN ('public', 'drizzle') AND relation.relkind IN ('r', 'p') \gexec
SELECT format('ALTER SEQUENCE %I.%I OWNER TO %I', namespace.nspname, relation.relname, '$migratorUser')
FROM pg_class relation
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname IN ('public', 'drizzle') AND relation.relkind = 'S' \gexec
SELECT format('ALTER VIEW %I.%I OWNER TO %I', namespace.nspname, relation.relname, '$migratorUser')
FROM pg_class relation
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public' AND relation.relkind = 'v' \gexec
SELECT format('ALTER MATERIALIZED VIEW %I.%I OWNER TO %I', namespace.nspname, relation.relname, '$migratorUser')
FROM pg_class relation
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public' AND relation.relkind = 'm' \gexec
SELECT format('ALTER FUNCTION %I.%I(%s) OWNER TO %I', namespace.nspname, procedure.proname, pg_get_function_identity_arguments(procedure.oid), '$migratorUser')
FROM pg_proc procedure
JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
WHERE namespace.nspname = 'public' AND procedure.prokind = 'f' \gexec
SELECT format('ALTER PROCEDURE %I.%I(%s) OWNER TO %I', namespace.nspname, procedure.proname, pg_get_function_identity_arguments(procedure.oid), '$migratorUser')
FROM pg_proc procedure
JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
WHERE namespace.nspname = 'public' AND procedure.prokind = 'p' \gexec

SELECT format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I, %I', current_database(), '$appUser', '$appRole') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), '$appRole') \gexec
SELECT format('GRANT CONNECT, CREATE ON DATABASE %I TO %I', current_database(), '$migratorRole') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I, %I', '$appUser', '$appRole') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', '$appRole') \gexec
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', '$migratorRole') \gexec
SELECT format('GRANT USAGE, CREATE ON SCHEMA drizzle TO %I', '$migratorRole')
WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I, %I', '$appUser', '$appRole') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', '$appRole') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I, %I', '$appUser', '$appRole') \gexec
SELECT format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', '$appRole') \gexec
SELECT format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, %I, %I', '$appUser', '$appRole') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC', '$migratorUser') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', '$migratorUser', '$appRole') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC', '$migratorUser') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', '$migratorUser', '$appRole') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC', '$migratorUser') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA drizzle FROM PUBLIC, %I, %I', '$appUser', '$appRole')
WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA drizzle FROM PUBLIC, %I, %I', '$appUser', '$appRole')
WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA drizzle FROM PUBLIC, %I, %I', '$appUser', '$appRole')
WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') \gexec

COMMIT;
"@

if (-not $PSCmdlet.ShouldProcess(
    $config.database.name,
    "Create/restrict dedicated PostgreSQL DML and DDL roles and rotate their passwords"
  )) {
  return
}

$psql = Get-PostgresTool -Config $config -Name psql
$adminPlain = Get-SecureStringPlainText -Value $administratorPassword
$appPlain = Get-SecureStringPlainText -Value $secrets.AppDatabasePassword
$migratorPlain = Get-SecureStringPlainText -Value $secrets.MigratorDatabasePassword
$previous = @{
  PGPASSWORD = $env:PGPASSWORD
  WATHAIQI_APP_DATABASE_PASSWORD = $env:WATHAIQI_APP_DATABASE_PASSWORD
  WATHAIQI_MIGRATOR_DATABASE_PASSWORD = $env:WATHAIQI_MIGRATOR_DATABASE_PASSWORD
}
try {
  $env:PGPASSWORD = $adminPlain
  $env:WATHAIQI_APP_DATABASE_PASSWORD = $appPlain
  $env:WATHAIQI_MIGRATOR_DATABASE_PASSWORD = $migratorPlain
  $arguments = @(
    "--host=127.0.0.1",
    "--port=$($config.database.port)",
    "--username=$PostgresAdministrator",
    "--dbname=$($config.database.name)",
    "--no-password",
    "--no-psqlrc"
  )
  $output = $sql | & $psql @arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    Fail-LocalProduction "PostgreSQL role initialization failed"
  }
} finally {
  foreach ($name in $previous.Keys) {
    if ($null -eq $previous[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    else { Set-Item "Env:$name" $previous[$name] }
  }
  $adminPlain = $null
  $appPlain = $null
  $migratorPlain = $null
}

Assert-MigratorDatabaseBoundary -Config $config -Secrets $secrets
Write-Output "PostgreSQL role initialization passed without printing credentials."
Write-Output "Run Invoke-Migrations.ps1 before starting the application."
