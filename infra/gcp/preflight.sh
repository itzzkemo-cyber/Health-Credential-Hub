#!/usr/bin/env bash
set -euo pipefail

# Read-only Google Cloud checks. Run this before bootstrap.sh so a missing
# account, inaccessible project, or disabled billing fails before any API is
# enabled or paid resource is created.
PROJECT_ID="${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT to the approved project id}"
REGION="${REGION:-me-central2}"

if [[ "${REGION}" != "me-central2" ]]; then
  echo "Production is restricted to me-central2 (Dammam)" >&2
  exit 1
fi

command -v gcloud >/dev/null || {
  echo "gcloud is required; use Google Cloud Shell or install the Google Cloud CLI" >&2
  exit 1
}

ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null)"
if [[ -z "${ACTIVE_ACCOUNT}" ]]; then
  echo "No active gcloud account; authenticate before continuing" >&2
  exit 1
fi
unset ACTIVE_ACCOUNT

if ! PROJECT_STATE="$(gcloud projects describe "${PROJECT_ID}" \
  --format='value(lifecycleState)' 2>/dev/null)"; then
  echo "The active account cannot read the selected Google Cloud project" >&2
  exit 1
fi
if [[ "${PROJECT_STATE}" != "ACTIVE" ]]; then
  echo "The selected Google Cloud project is not ACTIVE" >&2
  exit 1
fi

if ! BILLING_ENABLED="$(gcloud billing projects describe "${PROJECT_ID}" \
  --format='value(billingEnabled)' 2>/dev/null)"; then
  echo "Billing status could not be verified; grant read access to project billing metadata" >&2
  exit 1
fi
if [[ "${BILLING_ENABLED,,}" != "true" ]]; then
  echo "Billing is not enabled for the selected Google Cloud project" >&2
  exit 1
fi

printf 'Google Cloud preflight passed for project %s in %s (no resources changed).\n' \
  "${PROJECT_ID}" "${REGION}"
