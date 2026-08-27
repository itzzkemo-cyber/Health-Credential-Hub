#!/usr/bin/env bash
set -euo pipefail

# Run from Google Cloud Shell after selecting the approved production project.
# Required input: GOOGLE_CLOUD_PROJECT. Optional: REGION and resource names.
PROJECT_ID="${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT to the target project id}"
REGION="${REGION:-me-central2}"
SERVICE="${SERVICE:-health-credential-hub}"
SQL_INSTANCE="${SQL_INSTANCE:-healthdocs-postgres}"
DATABASE="${DATABASE:-healthdocs}"
DATABASE_USER="${DATABASE_USER:-healthdocs_app}"
DATABASE_ROLE="${DATABASE_ROLE:-healthdocs_app_dml}"
MIGRATOR_DATABASE_USER="${MIGRATOR_DATABASE_USER:-healthdocs_migrator}"
MIGRATOR_DATABASE_ROLE="${MIGRATOR_DATABASE_ROLE:-healthdocs_migrator_ddl}"
BUCKET="${BUCKET:-${PROJECT_ID}-healthdocs-private}"
REPOSITORY="${REPOSITORY:-healthdocs}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-healthdocs-runtime}"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
MIGRATOR_SERVICE_ACCOUNT="${MIGRATOR_SERVICE_ACCOUNT:-healthdocs-migrator}"
MIGRATOR_SERVICE_ACCOUNT_EMAIL="${MIGRATOR_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
BOOTSTRAP_ADMIN_SERVICE_ACCOUNT="${BOOTSTRAP_ADMIN_SERVICE_ACCOUNT:-healthdocs-bootstrap-admin}"
BOOTSTRAP_ADMIN_SERVICE_ACCOUNT_EMAIL="${BOOTSTRAP_ADMIN_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
AUTOMATION_SERVICE_ACCOUNT="${AUTOMATION_SERVICE_ACCOUNT:-healthdocs-automation}"
AUTOMATION_SERVICE_ACCOUNT_EMAIL="${AUTOMATION_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_SERVICE_ACCOUNT="${SCHEDULER_SERVICE_ACCOUNT:-healthdocs-automation-scheduler}"
SCHEDULER_SERVICE_ACCOUNT_EMAIL="${SCHEDULER_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
BUILD_SERVICE_ACCOUNT="${BUILD_SERVICE_ACCOUNT:-healthdocs-builder}"
BUILD_SERVICE_ACCOUNT_EMAIL="${BUILD_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
BUILD_SOURCE_BUCKET="${BUILD_SOURCE_BUCKET:-${PROJECT_ID}-healthdocs-build-source}"
IMAGE_REPOSITORY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE}"
AUTOMATION_OUTBOX_ENABLED="${AUTOMATION_OUTBOX_ENABLED:-false}"
AUTOMATION_WEBHOOK_ENABLED="${AUTOMATION_WEBHOOK_ENABLED:-false}"
AUTOMATION_WEBHOOK_MODE="${AUTOMATION_WEBHOOK_MODE:-}"
AUTOMATION_FACILITY_ALLOWLIST="${AUTOMATION_FACILITY_ALLOWLIST:-}"
AUTOMATION_WEBHOOK_URL="${AUTOMATION_WEBHOOK_URL:-}"

if [[ "${REGION}" != "me-central2" ]]; then
  echo "Production bootstrap is restricted to me-central2 (Dammam)" >&2
  exit 1
fi
AUTOMATION_WEBHOOK_HOST_ALLOWLIST="${AUTOMATION_WEBHOOK_HOST_ALLOWLIST:-}"
AUTOMATION_SCHEDULE="${AUTOMATION_SCHEDULE:-*/5 * * * *}"
AUTOMATION_SCHEDULE_TIME_ZONE="${AUTOMATION_SCHEDULE_TIME_ZONE:-Asia/Riyadh}"

if [[ "${AUTOMATION_WEBHOOK_ENABLED}" == "true" ]]; then
  [[ "${AUTOMATION_OUTBOX_ENABLED}" == "true" ]] || {
    echo "Webhook delivery requires AUTOMATION_OUTBOX_ENABLED=true" >&2
    exit 1
  }
  [[ "${AUTOMATION_WEBHOOK_MODE}" == "SINGLE_CONTROLLER" ]] || {
    echo "Enabled automation requires AUTOMATION_WEBHOOK_MODE=SINGLE_CONTROLLER" >&2
    exit 1
  }
  [[ -n "${AUTOMATION_WEBHOOK_HOST_ALLOWLIST}" ]] || {
    echo "Enabled automation requires AUTOMATION_WEBHOOK_HOST_ALLOWLIST" >&2
    exit 1
  }
  [[ "${AUTOMATION_WEBHOOK_URL}" == https://* ]] || {
    echo "Enabled automation requires an HTTPS AUTOMATION_WEBHOOK_URL" >&2
    exit 1
  }
elif [[ "${AUTOMATION_WEBHOOK_ENABLED}" != "false" ]]; then
  echo "AUTOMATION_WEBHOOK_ENABLED must be true or false" >&2
  exit 1
fi
[[ "${AUTOMATION_OUTBOX_ENABLED}" == "true" || "${AUTOMATION_OUTBOX_ENABLED}" == "false" ]] || {
  echo "AUTOMATION_OUTBOX_ENABLED must be true or false" >&2
  exit 1
}
if [[ "${AUTOMATION_OUTBOX_ENABLED}" == "true" ]]; then
  [[ "${AUTOMATION_FACILITY_ALLOWLIST}" =~ ^[1-9][0-9]*(,[1-9][0-9]*)*$ ]] || {
    echo "Enabled automation requires comma-separated positive facility IDs" >&2
    exit 1
  }
fi

for database_identifier in DATABASE DATABASE_USER DATABASE_ROLE MIGRATOR_DATABASE_USER MIGRATOR_DATABASE_ROLE; do
  if [[ ! "${!database_identifier}" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; then
    echo "${database_identifier} must be a lowercase PostgreSQL identifier" >&2
    exit 1
  fi
done
database_identities=(
  "${DATABASE_USER}"
  "${DATABASE_ROLE}"
  "${MIGRATOR_DATABASE_USER}"
  "${MIGRATOR_DATABASE_ROLE}"
)
for ((i = 0; i < ${#database_identities[@]}; i++)); do
  for ((j = i + 1; j < ${#database_identities[@]}; j++)); do
    if [[ "${database_identities[i]}" == "${database_identities[j]}" ]]; then
      echo "Application and migration database identities must all be distinct" >&2
      exit 1
    fi
  done
done
unset database_identities i j

for required_command in gcloud openssl git grep tail tr curl mktemp chmod rm; do
  command -v "${required_command}" >/dev/null || {
    echo "${required_command} is required" >&2
    exit 1
  }
done

TEMP_FILES=()
cleanup_temp_files() {
  local temp_file
  for temp_file in "${TEMP_FILES[@]:-}"; do
    if [[ -n "${temp_file}" ]]; then
      rm -f -- "${temp_file}"
    fi
  done
}
trap cleanup_temp_files EXIT

# This is intentionally read-only and runs before enabling services or creating
# paid resources. It also avoids leaking the active account or billing account.
bash infra/gcp/preflight.sh

RELEASE_SHA="${RELEASE_SHA:-$(git rev-parse HEAD)}"
if [[ ! "${RELEASE_SHA}" =~ ^[0-9a-f]{7,40}$ ]] || \
  [[ "$(git rev-parse "${RELEASE_SHA}^{commit}")" != "$(git rev-parse HEAD)" ]]; then
  echo "RELEASE_SHA must identify the checked-out HEAD commit" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "Refusing to bootstrap from a dirty working tree" >&2
  exit 1
fi
IMAGE_TAG="${IMAGE_REPOSITORY}:${RELEASE_SHA}"

gcloud config set project "${PROJECT_ID}" >/dev/null
gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com \
  run.googleapis.com \
  sqladmin.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com

if ! gcloud iam service-accounts describe "${SERVICE_ACCOUNT_EMAIL}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SERVICE_ACCOUNT}" \
    --display-name="Health Credential Hub runtime"
fi

if ! gcloud iam service-accounts describe "${BUILD_SERVICE_ACCOUNT_EMAIL}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${BUILD_SERVICE_ACCOUNT}" \
    --display-name="Health Credential Hub container builder"
fi

if ! gcloud iam service-accounts describe "${AUTOMATION_SERVICE_ACCOUNT_EMAIL}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${AUTOMATION_SERVICE_ACCOUNT}" \
    --display-name="Health Credential Hub automation worker"
fi

if ! gcloud iam service-accounts describe "${MIGRATOR_SERVICE_ACCOUNT_EMAIL}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${MIGRATOR_SERVICE_ACCOUNT}" \
    --display-name="Health Credential Hub database migrator"
fi

if ! gcloud iam service-accounts describe "${BOOTSTRAP_ADMIN_SERVICE_ACCOUNT_EMAIL}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${BOOTSTRAP_ADMIN_SERVICE_ACCOUNT}" \
    --display-name="Health Credential Hub first administrator bootstrap"
fi

if ! gcloud iam service-accounts describe "${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SCHEDULER_SERVICE_ACCOUNT}" \
    --display-name="Health Credential Hub automation scheduler invoker"
fi

SUBMITTER_ACCOUNT="$(gcloud config get-value account 2>/dev/null)"
if [[ -z "${SUBMITTER_ACCOUNT}" || "${SUBMITTER_ACCOUNT}" == "(unset)" ]]; then
  echo "An authenticated gcloud account is required" >&2
  exit 1
fi
if [[ "${SUBMITTER_ACCOUNT}" == *".gserviceaccount.com" ]]; then
  SUBMITTER_MEMBER="serviceAccount:${SUBMITTER_ACCOUNT}"
else
  SUBMITTER_MEMBER="user:${SUBMITTER_ACCOUNT}"
fi
gcloud iam service-accounts add-iam-policy-binding "${BUILD_SERVICE_ACCOUNT_EMAIL}" \
  --member="${SUBMITTER_MEMBER}" \
  --role=roles/iam.serviceAccountUser >/dev/null

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role=roles/cloudsql.client --condition=None >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${AUTOMATION_SERVICE_ACCOUNT_EMAIL}" \
  --role=roles/cloudsql.client --condition=None >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${MIGRATOR_SERVICE_ACCOUNT_EMAIL}" \
  --role=roles/cloudsql.client --condition=None >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${BOOTSTRAP_ADMIN_SERVICE_ACCOUNT_EMAIL}" \
  --role=roles/cloudsql.client --condition=None >/dev/null
# Cloud Run uses IAM signBlob to create 15-minute upload URLs without a JSON key.
gcloud iam service-accounts add-iam-policy-binding "${SERVICE_ACCOUNT_EMAIL}" \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role=roles/iam.serviceAccountTokenCreator >/dev/null

if ! gcloud sql instances describe "${SQL_INSTANCE}" >/dev/null 2>&1; then
  gcloud sql instances create "${SQL_INSTANCE}" \
    --database-version=POSTGRES_16 \
    --region="${REGION}" \
    --tier=db-custom-1-3840 \
    --availability-type=REGIONAL \
    --storage-type=SSD \
    --storage-size=20 \
    --storage-auto-increase \
    --backup-start-time=02:00 \
    --enable-point-in-time-recovery \
    --deletion-protection
fi

if ! gcloud sql databases describe "${DATABASE}" --instance="${SQL_INSTANCE}" >/dev/null 2>&1; then
  gcloud sql databases create "${DATABASE}" --instance="${SQL_INSTANCE}" --charset=UTF8
fi

ensure_secret() {
  local name="$1"
  local value="$2"
  if ! gcloud secrets describe "${name}" >/dev/null 2>&1; then
    printf %s "${value}" | gcloud secrets create "${name}" \
      --replication-policy=user-managed \
      --locations="${REGION}" \
      --data-file=- >/dev/null
  fi
}

ensure_secret_value() {
  local name="$1"
  local value="$2"
  local current_value
  if ! gcloud secrets describe "${name}" >/dev/null 2>&1; then
    printf %s "${value}" | gcloud secrets create "${name}" \
      --replication-policy=user-managed \
      --locations="${REGION}" \
      --data-file=- >/dev/null
    return
  fi
  current_value="$(gcloud secrets versions access latest --secret="${name}")"
  if [[ "${current_value}" != "${value}" ]]; then
    printf %s "${value}" | gcloud secrets versions add "${name}" \
      --data-file=- >/dev/null
  fi
  unset current_value
}

ensure_sql_user() {
  local user="$1"
  local password="$2"
  local password_flags_file
  local yaml_password
  if [[ "${password}" == *$'\n'* ]] || [[ "${password}" == *$'\r'* ]]; then
    echo "Cloud SQL passwords must not contain line breaks" >&2
    exit 1
  fi
  password_flags_file="$(mktemp)"
  TEMP_FILES+=("${password_flags_file}")
  chmod 600 "${password_flags_file}"
  yaml_password="${password//\'/\'\'}"
  printf "password: '%s'\n" "${yaml_password}" > "${password_flags_file}"
  if gcloud sql users list --instance="${SQL_INSTANCE}" \
    --filter="name=${user}" --format='value(name)' | grep -qx "${user}"; then
    gcloud sql users set-password "${user}" \
      --instance="${SQL_INSTANCE}" \
      --flags-file="${password_flags_file}" >/dev/null
  else
    gcloud sql users create "${user}" \
      --instance="${SQL_INSTANCE}" \
      --flags-file="${password_flags_file}" >/dev/null
  fi
  rm -f -- "${password_flags_file}"
  unset password password_flags_file yaml_password
}

if ! gcloud secrets describe healthdocs-db-password >/dev/null 2>&1; then
  ensure_secret healthdocs-db-password "$(openssl rand -hex 32)"
fi
if ! gcloud secrets describe healthdocs-migrator-db-password >/dev/null 2>&1; then
  ensure_secret healthdocs-migrator-db-password "$(openssl rand -hex 32)"
fi
APP_DB_PASSWORD="$(gcloud secrets versions access latest --secret=healthdocs-db-password)"
MIGRATOR_DB_PASSWORD="$(gcloud secrets versions access latest --secret=healthdocs-migrator-db-password)"

# Cloud SQL grants cloudsqlsuperuser to new built-in users. The first migration
# run uses that bootstrap privilege to establish ownership and custom roles.
# The supported Cloud SQL Admin API then replaces all broad memberships before
# a strict second run verifies least privilege and before public deployment.
ensure_sql_user "${DATABASE_USER}" "${APP_DB_PASSWORD}"
ensure_sql_user "${MIGRATOR_DATABASE_USER}" "${MIGRATOR_DB_PASSWORD}"

CONNECTION_NAME="$(gcloud sql instances describe "${SQL_INSTANCE}" --format='value(connectionName)')"
APP_DATABASE_URL="postgresql://${DATABASE_USER}:${APP_DB_PASSWORD}@/${DATABASE}?host=/cloudsql/${CONNECTION_NAME}"
MIGRATOR_DATABASE_URL="postgresql://${MIGRATOR_DATABASE_USER}:${MIGRATOR_DB_PASSWORD}@/${DATABASE}?host=/cloudsql/${CONNECTION_NAME}"
ensure_secret_value healthdocs-database-url "${APP_DATABASE_URL}"
ensure_secret_value healthdocs-migrator-database-url "${MIGRATOR_DATABASE_URL}"
ensure_secret healthdocs-session-secret "$(openssl rand -hex 48)"
ensure_secret healthdocs-totp-key "$(openssl rand -base64 32 | tr -d '\n')"
ensure_secret healthdocs-automation-webhook-secret "$(openssl rand -base64 32 | tr -d '\n')"
unset APP_DB_PASSWORD MIGRATOR_DB_PASSWORD APP_DATABASE_URL MIGRATOR_DATABASE_URL

# Grant the runtime access only to the secrets this service consumes. Avoid a
# project-wide secretAccessor role so unrelated secrets remain unreadable.
for secret in healthdocs-database-url healthdocs-session-secret healthdocs-totp-key; do
  gcloud secrets add-iam-policy-binding "${secret}" \
    --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role=roles/secretmanager.secretAccessor >/dev/null
done

# The webhook secret is available only to the dedicated worker identity; the
# public API runtime cannot fetch or mount it.
for secret in healthdocs-database-url healthdocs-automation-webhook-secret; do
  gcloud secrets add-iam-policy-binding "${secret}" \
    --member="serviceAccount:${AUTOMATION_SERVICE_ACCOUNT_EMAIL}" \
    --role=roles/secretmanager.secretAccessor >/dev/null
done

# The migrator receives only the DDL connection. First-admin receives the same
# DML-only connection as the API and cannot apply schema changes.
gcloud secrets add-iam-policy-binding healthdocs-migrator-database-url \
  --member="serviceAccount:${MIGRATOR_SERVICE_ACCOUNT_EMAIL}" \
  --role=roles/secretmanager.secretAccessor >/dev/null
# Remove the legacy shared-connection grant when upgrading an existing
# bootstrap. A migrator must never be able to fetch the application's DML URL.
if gcloud secrets get-iam-policy healthdocs-database-url \
  --flatten='bindings[].members' \
  --filter="bindings.role=roles/secretmanager.secretAccessor AND bindings.members=serviceAccount:${MIGRATOR_SERVICE_ACCOUNT_EMAIL}" \
  --format='value(bindings.members)' | \
  grep -Fqx "serviceAccount:${MIGRATOR_SERVICE_ACCOUNT_EMAIL}"; then
  gcloud secrets remove-iam-policy-binding healthdocs-database-url \
    --member="serviceAccount:${MIGRATOR_SERVICE_ACCOUNT_EMAIL}" \
    --role=roles/secretmanager.secretAccessor >/dev/null
fi
gcloud secrets add-iam-policy-binding healthdocs-database-url \
  --member="serviceAccount:${BOOTSTRAP_ADMIN_SERVICE_ACCOUNT_EMAIL}" \
  --role=roles/secretmanager.secretAccessor >/dev/null

if ! gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET}" \
    --location="${REGION}" \
    --uniform-bucket-level-access \
    --public-access-prevention
fi
gcloud storage buckets update "gs://${BUCKET}" \
  --soft-delete-duration=7d \
  --versioning >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role=roles/storage.objectUser >/dev/null
# Runtime readiness checks call storage.buckets.get. legacyBucketReader is the
# narrow predefined bucket-metadata role; storage.admin is intentionally not
# granted.
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role=roles/storage.legacyBucketReader >/dev/null

if ! gcloud artifacts repositories describe "${REPOSITORY}" --location="${REGION}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${REPOSITORY}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Health Credential Hub production images"
fi

if ! gcloud storage buckets describe "gs://${BUILD_SOURCE_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUILD_SOURCE_BUCKET}" \
    --location="${REGION}" \
    --uniform-bucket-level-access \
    --public-access-prevention
fi
gcloud storage buckets update "gs://${BUILD_SOURCE_BUCKET}" \
  --lifecycle-file=infra/gcp/build-source-lifecycle.json >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUILD_SOURCE_BUCKET}" \
  --member="serviceAccount:${BUILD_SERVICE_ACCOUNT_EMAIL}" \
  --role=roles/storage.objectViewer >/dev/null
gcloud artifacts repositories add-iam-policy-binding "${REPOSITORY}" \
  --location="${REGION}" \
  --member="serviceAccount:${BUILD_SERVICE_ACCOUNT_EMAIL}" \
  --role=roles/artifactregistry.writer >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${BUILD_SERVICE_ACCOUNT_EMAIL}" \
  --role=roles/logging.logWriter \
  --condition=None >/dev/null

IMAGE_DIGEST="$(gcloud builds submit . \
  --config=cloudbuild.yaml \
  --substitutions="_IMAGE=${IMAGE_TAG}" \
  --service-account="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SERVICE_ACCOUNT_EMAIL}" \
  --gcs-source-staging-dir="gs://${BUILD_SOURCE_BUCKET}/source" \
  --format='value(results.images[0].digest)' | tail -n1)"
if [[ ! "${IMAGE_DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Cloud Build did not return a valid image digest" >&2
  exit 1
fi
IMAGE_REF="${IMAGE_REPOSITORY}@${IMAGE_DIGEST}"

COMMON_ENV="^|^NODE_ENV=production|BIND_HOST=0.0.0.0|GOOGLE_CLOUD_PROJECT=${PROJECT_ID}|DB_POOL_MAX=10|OBJECT_STORAGE_PROVIDER=gcs|PRIVATE_OBJECT_DIR=/${BUCKET}/private|STORAGE_API_ENDPOINT=https://storage.${REGION}.rep.googleapis.com|SESSION_COOKIE_SAME_SITE=lax|EMAIL_ALERTS_DISABLED=1|AUTOMATION_OUTBOX_ENABLED=${AUTOMATION_OUTBOX_ENABLED}|AUTOMATION_FACILITY_ALLOWLIST=${AUTOMATION_FACILITY_ALLOWLIST}"

gcloud run jobs deploy "${SERVICE}-migrate" \
  --image="${IMAGE_REF}" \
  --region="${REGION}" \
  --service-account="${MIGRATOR_SERVICE_ACCOUNT_EMAIL}" \
  --set-cloudsql-instances="${CONNECTION_NAME}" \
  --set-secrets="DATABASE_URL=healthdocs-migrator-database-url:latest" \
  --set-env-vars="^|^NODE_ENV=production|MIGRATIONS_DIR=/app/migrations|DB_POOL_MAX=2|APP_DATABASE_USER=${DATABASE_USER}|APP_DATABASE_ROLE=${DATABASE_ROLE}|MIGRATOR_DATABASE_USER=${MIGRATOR_DATABASE_USER}|MIGRATOR_DATABASE_ROLE=${MIGRATOR_DATABASE_ROLE}" \
  --command=node \
  --args=dist/migrate.mjs \
  --max-retries=0 \
  --task-timeout=10m

# PostgreSQL 16 requires SET membership in an object's current owner before
# REASSIGN OWNED. Add the application login temporarily without replacing the
# migrator's bootstrap membership; the final assignment below removes both.
gcloud sql users assign-roles "${MIGRATOR_DATABASE_USER}" \
  --instance="${SQL_INSTANCE}" \
  --type=BUILT_IN \
  --database-roles="${DATABASE_USER}" >/dev/null
gcloud run jobs execute "${SERVICE}-migrate" --region="${REGION}" --wait

# Replace the automatic cloudsqlsuperuser membership only after the custom
# roles exist. This is idempotent and ensures future releases start with the
# same reviewed DDL/DML boundary.
gcloud sql users assign-roles "${DATABASE_USER}" \
  --instance="${SQL_INSTANCE}" \
  --type=BUILT_IN \
  --database-roles="${DATABASE_ROLE}" \
  --revoke-existing-roles >/dev/null
gcloud sql users assign-roles "${MIGRATOR_DATABASE_USER}" \
  --instance="${SQL_INSTANCE}" \
  --type=BUILT_IN \
  --database-roles="${MIGRATOR_DATABASE_ROLE}" \
  --revoke-existing-roles >/dev/null

# Re-run under the final role assignments. The override makes the entrypoint
# fail closed if either login still has cloudsqlsuperuser, CREATEROLE,
# CREATEDB, replication/BYPASSRLS, or an unexpected direct membership.
gcloud run jobs execute "${SERVICE}-migrate" \
  --region="${REGION}" \
  --update-env-vars=VERIFY_DATABASE_ROLE_BOUNDARY=true \
  --wait

# Inert until an operator supplies the exact guarded environment and a
# short-lived password secret. Missing BOOTSTRAP_CONFIRM makes accidental runs
# fail before any database write.
gcloud run jobs deploy "${SERVICE}-bootstrap-admin" \
  --image="${IMAGE_REF}" \
  --region="${REGION}" \
  --service-account="${BOOTSTRAP_ADMIN_SERVICE_ACCOUNT_EMAIL}" \
  --set-cloudsql-instances="${CONNECTION_NAME}" \
  --set-secrets="DATABASE_URL=healthdocs-database-url:latest" \
  --set-env-vars="NODE_ENV=production,DB_POOL_MAX=1" \
  --command=node \
  --args=dist/bootstrap-admin.mjs \
  --max-retries=0 \
  --task-timeout=10m

# Deploy the optional worker now so releases update it with the same reviewed
# image. It stays inert until an operator supplies the approved HTTPS endpoint
# and enables both automation flags. The separate identity is intentionally
# not granted GCS, session-secret, or TOTP-secret access.
gcloud run jobs deploy "${SERVICE}-automation" \
  --image="${IMAGE_REF}" \
  --region="${REGION}" \
  --service-account="${AUTOMATION_SERVICE_ACCOUNT_EMAIL}" \
  --set-cloudsql-instances="${CONNECTION_NAME}" \
  --set-secrets="DATABASE_URL=healthdocs-database-url:latest,AUTOMATION_WEBHOOK_SECRET=healthdocs-automation-webhook-secret:latest" \
  --set-env-vars="^|^NODE_ENV=production|DB_POOL_MAX=2|AUTOMATION_OUTBOX_ENABLED=${AUTOMATION_OUTBOX_ENABLED}|AUTOMATION_WEBHOOK_ENABLED=${AUTOMATION_WEBHOOK_ENABLED}|AUTOMATION_WEBHOOK_MODE=${AUTOMATION_WEBHOOK_MODE}|AUTOMATION_FACILITY_ALLOWLIST=${AUTOMATION_FACILITY_ALLOWLIST}|AUTOMATION_WEBHOOK_URL=${AUTOMATION_WEBHOOK_URL}|AUTOMATION_WEBHOOK_HOST_ALLOWLIST=${AUTOMATION_WEBHOOK_HOST_ALLOWLIST}|AUTOMATION_WORKER_MODE=once" \
  --command=node \
  --args=dist/automation-worker.mjs \
  --max-retries=0 \
  --task-timeout=15m

# Scheduler can invoke only this Job. It receives no database, webhook, GCS,
# session, or TOTP secret and is paused unless delivery was explicitly enabled.
gcloud run jobs add-iam-policy-binding "${SERVICE}-automation" \
  --region="${REGION}" \
  --member="serviceAccount:${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" \
  --role=roles/run.invoker >/dev/null
AUTOMATION_RUN_URI="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${SERVICE}-automation:run"
if gcloud scheduler jobs describe "${SERVICE}-automation" --location="${REGION}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${SERVICE}-automation" \
    --location="${REGION}" \
    --schedule="${AUTOMATION_SCHEDULE}" \
    --time-zone="${AUTOMATION_SCHEDULE_TIME_ZONE}" \
    --uri="${AUTOMATION_RUN_URI}" \
    --http-method=POST \
    --oauth-service-account-email="${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" \
    --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform"
else
  gcloud scheduler jobs create http "${SERVICE}-automation" \
    --location="${REGION}" \
    --schedule="${AUTOMATION_SCHEDULE}" \
    --time-zone="${AUTOMATION_SCHEDULE_TIME_ZONE}" \
    --uri="${AUTOMATION_RUN_URI}" \
    --http-method=POST \
    --oauth-service-account-email="${SCHEDULER_SERVICE_ACCOUNT_EMAIL}" \
    --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform"
fi
SCHEDULER_STATE="$(gcloud scheduler jobs describe "${SERVICE}-automation" --location="${REGION}" --format='value(state)')"
if [[ "${AUTOMATION_WEBHOOK_ENABLED}" == "true" && "${SCHEDULER_STATE}" == "PAUSED" ]]; then
  gcloud scheduler jobs resume "${SERVICE}-automation" --location="${REGION}"
elif [[ "${AUTOMATION_WEBHOOK_ENABLED}" != "true" && "${SCHEDULER_STATE}" != "PAUSED" ]]; then
  gcloud scheduler jobs pause "${SERVICE}-automation" --location="${REGION}"
fi

gcloud run deploy "${SERVICE}" \
  --image="${IMAGE_REF}" \
  --region="${REGION}" \
  --service-account="${SERVICE_ACCOUNT_EMAIL}" \
  --set-cloudsql-instances="${CONNECTION_NAME}" \
  --set-secrets="DATABASE_URL=healthdocs-database-url:latest,SESSION_SECRET=healthdocs-session-secret:latest,TOTP_ENCRYPTION_KEY=healthdocs-totp-key:latest" \
  --set-env-vars="${COMMON_ENV}" \
  --execution-environment=gen2 \
  --port=8080 \
  --cpu=1 \
  --memory=1Gi \
  --concurrency=40 \
  --min=0 \
  --max=1 \
  --allow-unauthenticated

SERVICE_URL="$(gcloud run services describe "${SERVICE}" --region="${REGION}" --format='value(status.url)')"
gcloud run services update "${SERVICE}" \
  --region="${REGION}" \
  --update-env-vars="PUBLIC_APP_URL=${SERVICE_URL},APP_ORIGINS=${SERVICE_URL}" >/dev/null

CORS_FILE="$(mktemp)"
TEMP_FILES+=("${CORS_FILE}")
printf '[{"origin":["%s"],"method":["PUT"],"responseHeader":["Content-Type","x-goog-if-generation-match"],"maxAgeSeconds":900}]' \
  "${SERVICE_URL}" > "${CORS_FILE}"
gcloud storage buckets update "gs://${BUCKET}" --cors-file="${CORS_FILE}" >/dev/null

curl --fail --silent --show-error "${SERVICE_URL}/api/readyz"
if [[ "${AUTOMATION_WEBHOOK_ENABLED}" == "true" ]]; then
  gcloud run jobs execute "${SERVICE}-automation" --region="${REGION}" --wait
fi
printf '\nLive URL: %s\n' "${SERVICE_URL}"
