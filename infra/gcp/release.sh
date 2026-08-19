#!/usr/bin/env bash
set -euo pipefail

# Deploy an already-provisioned Health Credential Hub installation. The first
# deployment must be created with infra/gcp/bootstrap.sh.
PROJECT_ID="${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT}"
REGION="${REGION:-me-central2}"
SERVICE="${SERVICE:-health-credential-hub}"
REPOSITORY="${REPOSITORY:-healthdocs}"
BUILD_SERVICE_ACCOUNT="${BUILD_SERVICE_ACCOUNT:-healthdocs-builder}"
BUILD_SOURCE_BUCKET="${BUILD_SOURCE_BUCKET:-${PROJECT_ID}-healthdocs-build-source}"
RELEASE_SHA="${RELEASE_SHA:-$(git rev-parse HEAD)}"
SMOKE_URL="${SMOKE_URL:-}"

if [[ "${REGION}" != "me-central2" ]]; then
  echo "Production releases are restricted to me-central2 (Dammam)" >&2
  exit 1
fi

if [[ ! "${RELEASE_SHA}" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "RELEASE_SHA must be a Git commit SHA" >&2
  exit 1
fi

command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }

HEAD_SHA="$(git rev-parse HEAD)"
RELEASE_COMMIT="$(git rev-parse "${RELEASE_SHA}^{commit}")"
if [[ "${HEAD_SHA}" != "${RELEASE_COMMIT}" ]]; then
  echo "RELEASE_SHA must identify the checked-out HEAD commit" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "Refusing to release a dirty working tree" >&2
  exit 1
fi

BUILD_SERVICE_ACCOUNT_EMAIL="${BUILD_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE_REPOSITORY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE}"
IMAGE_TAG="${IMAGE_REPOSITORY}:${RELEASE_SHA}"

gcloud config set project "${PROJECT_ID}" >/dev/null
if ! gcloud run jobs describe "${SERVICE}-automation" \
  --region="${REGION}" >/dev/null 2>&1; then
  echo "Automation job is missing; rerun the reviewed bootstrap before release" >&2
  exit 1
fi
if ! gcloud scheduler jobs describe "${SERVICE}-automation" \
  --location="${REGION}" >/dev/null 2>&1; then
  echo "Automation scheduler is missing; rerun the reviewed bootstrap before release" >&2
  exit 1
fi

SCHEDULER_STATE="$(gcloud scheduler jobs describe "${SERVICE}-automation" \
  --location="${REGION}" --format='value(state)')"
SCHEDULER_WAS_ENABLED=false
restore_scheduler() {
  if [[ "${SCHEDULER_WAS_ENABLED}" == "true" ]]; then
    gcloud scheduler jobs resume "${SERVICE}-automation" \
      --location="${REGION}" >/dev/null || \
      echo "WARNING: automation scheduler must be resumed manually" >&2
  fi
}
trap restore_scheduler EXIT
if [[ "${SCHEDULER_STATE}" == "ENABLED" ]]; then
  gcloud scheduler jobs pause "${SERVICE}-automation" --location="${REGION}"
  SCHEDULER_WAS_ENABLED=true
elif [[ "${SCHEDULER_STATE}" != "PAUSED" ]]; then
  echo "Unexpected automation scheduler state: ${SCHEDULER_STATE}" >&2
  exit 1
fi

# Build with the dedicated builder identity. No long-lived JSON key is used.
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

# Apply reviewed migrations before switching the service image. The migration
# job keeps the secrets, Cloud SQL attachment, command, and limits provisioned
# by bootstrap.sh.
gcloud run jobs update "${SERVICE}-migrate" \
  --image="${IMAGE_REF}" \
  --region="${REGION}"
gcloud run jobs execute "${SERVICE}-migrate" \
  --region="${REGION}" \
  --wait

# Preserve the service's existing secrets, environment, IAM, and scaling
# configuration while replacing only the immutable image revision.
PREVIOUS_REVISION="$(gcloud run services describe "${SERVICE}" \
  --region="${REGION}" \
  --format='value(status.latestReadyRevisionName)')"
if [[ -z "${PREVIOUS_REVISION}" ]]; then
  echo "No ready Cloud Run revision exists; run bootstrap.sh first" >&2
  exit 1
fi
gcloud run services update "${SERVICE}" \
  --image="${IMAGE_REF}" \
  --region="${REGION}"

SERVICE_URL="$(gcloud run services describe "${SERVICE}" \
  --region="${REGION}" \
  --format='value(status.url)')"
HEALTHCHECK_URL="${SMOKE_URL:-${SERVICE_URL}}"
if ! curl --fail --silent --show-error --retry 6 --retry-delay 5 \
  "${HEALTHCHECK_URL%/}/api/readyz"; then
  echo "Readiness failed; restoring traffic to ${PREVIOUS_REVISION}" >&2
  gcloud run services update-traffic "${SERVICE}" \
    --region="${REGION}" \
    --to-revisions="${PREVIOUS_REVISION}=100"
  exit 1
fi

# Update the separately provisioned worker only after the public service is
# healthy. Its flags, secret, URL, and schedule remain unchanged; a release
# never enables an external processor by itself.
if ! gcloud run jobs update "${SERVICE}-automation" \
  --image="${IMAGE_REF}" \
  --region="${REGION}"; then
  echo "Automation image update failed; restoring service traffic" >&2
  gcloud run services update-traffic "${SERVICE}" \
    --region="${REGION}" \
    --to-revisions="${PREVIOUS_REVISION}=100"
  exit 1
fi
printf '\nReleased %s to %s\n' "${RELEASE_SHA}" "${SERVICE_URL}"
