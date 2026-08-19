#!/usr/bin/env bash
set -euo pipefail

# Run from Google Cloud Shell after selecting a CNTXT-backed KSA project.
# Required input: GOOGLE_CLOUD_PROJECT. Optional: REGION and resource names.
PROJECT_ID="${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT to the target project id}"
REGION="${REGION:-me-central2}"
SERVICE="${SERVICE:-health-credential-hub}"
SQL_INSTANCE="${SQL_INSTANCE:-healthdocs-postgres}"
DATABASE="${DATABASE:-healthdocs}"
DATABASE_USER="${DATABASE_USER:-healthdocs_app}"
BUCKET="${BUCKET:-${PROJECT_ID}-healthdocs-private}"
REPOSITORY="${REPOSITORY:-healthdocs}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-healthdocs-runtime}"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
BUILD_SERVICE_ACCOUNT="${BUILD_SERVICE_ACCOUNT:-healthdocs-builder}"
BUILD_SERVICE_ACCOUNT_EMAIL="${BUILD_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
BUILD_SOURCE_BUCKET="${BUILD_SOURCE_BUCKET:-${PROJECT_ID}-healthdocs-build-source}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE}:latest"

command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

gcloud config set project "${PROJECT_ID}" >/dev/null
gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
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

if ! gcloud secrets describe healthdocs-db-password >/dev/null 2>&1; then
  ensure_secret healthdocs-db-password "$(openssl rand -hex 32)"
fi
DB_PASSWORD="$(gcloud secrets versions access latest --secret=healthdocs-db-password)"

if gcloud sql users list --instance="${SQL_INSTANCE}" \
  --filter="name=${DATABASE_USER}" --format='value(name)' | grep -qx "${DATABASE_USER}"; then
  gcloud sql users set-password "${DATABASE_USER}" \
    --instance="${SQL_INSTANCE}" \
    --password="${DB_PASSWORD}"
else
  gcloud sql users create "${DATABASE_USER}" \
    --instance="${SQL_INSTANCE}" \
    --password="${DB_PASSWORD}"
fi

CONNECTION_NAME="$(gcloud sql instances describe "${SQL_INSTANCE}" --format='value(connectionName)')"
DATABASE_URL="postgresql://${DATABASE_USER}:${DB_PASSWORD}@/${DATABASE}?host=/cloudsql/${CONNECTION_NAME}"
ensure_secret healthdocs-database-url "${DATABASE_URL}"
ensure_secret healthdocs-session-secret "$(openssl rand -hex 48)"
ensure_secret healthdocs-totp-key "$(openssl rand -base64 32 | tr -d '\n')"
unset DB_PASSWORD DATABASE_URL

# Grant the runtime access only to the secrets this service consumes. Avoid a
# project-wide secretAccessor role so unrelated secrets remain unreadable.
for secret in healthdocs-database-url healthdocs-session-secret healthdocs-totp-key; do
  gcloud secrets add-iam-policy-binding "${secret}" \
    --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role=roles/secretmanager.secretAccessor >/dev/null
done

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

gcloud builds submit . \
  --config=cloudbuild.yaml \
  --substitutions="_IMAGE=${IMAGE}" \
  --service-account="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SERVICE_ACCOUNT_EMAIL}" \
  --gcs-source-staging-dir="gs://${BUILD_SOURCE_BUCKET}/source"

COMMON_ENV="NODE_ENV=production,DB_POOL_MAX=10,PRIVATE_OBJECT_DIR=/${BUCKET}/private,STORAGE_API_ENDPOINT=https://storage.${REGION}.rep.googleapis.com,SESSION_COOKIE_SAME_SITE=lax,DEMO_LOGIN_ENABLED=false,ALLOW_DEMO_SEED=false,SELF_REGISTRATION_ENABLED=false,GOOGLE_AUTO_PROVISION_ENABLED=false,EMAIL_ALERTS_DISABLED=1"

gcloud run jobs deploy "${SERVICE}-migrate" \
  --image="${IMAGE}" \
  --region="${REGION}" \
  --service-account="${SERVICE_ACCOUNT_EMAIL}" \
  --set-cloudsql-instances="${CONNECTION_NAME}" \
  --set-secrets="DATABASE_URL=healthdocs-database-url:latest" \
  --set-env-vars="MIGRATIONS_DIR=/app/migrations,DB_POOL_MAX=2" \
  --command=node \
  --args=dist/migrate.mjs \
  --max-retries=0 \
  --task-timeout=10m
gcloud run jobs execute "${SERVICE}-migrate" --region="${REGION}" --wait

gcloud run deploy "${SERVICE}" \
  --image="${IMAGE}" \
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
trap 'rm -f "${CORS_FILE}"' EXIT
printf '[{"origin":["%s"],"method":["PUT"],"responseHeader":["Content-Type","x-goog-if-generation-match"],"maxAgeSeconds":900}]' \
  "${SERVICE_URL}" > "${CORS_FILE}"
gcloud storage buckets update "gs://${BUCKET}" --cors-file="${CORS_FILE}" >/dev/null

curl --fail --silent --show-error "${SERVICE_URL}/api/readyz"
printf '\nLive URL: %s\n' "${SERVICE_URL}"
