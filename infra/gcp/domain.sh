#!/usr/bin/env bash
set -euo pipefail

# Idempotently connect the reviewed production hostname to the existing
# Dammam Cloud Run service through a global external HTTPS load balancer.
#
# First run: provisions the load-balancer resources, prints the reserved IP,
# and exits 2 until the operator creates the Squarespace DNS A record and the
# Google-managed certificate becomes ACTIVE.
# Subsequent run: verifies every existing resource, updates the canonical app
# origin and bucket CORS, smoke-tests HTTPS, then removes the direct run.app URL.

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT to the approved project id}"
REGION="${REGION:-me-central2}"
SERVICE="${SERVICE:-health-credential-hub}"
DOMAIN="${DOMAIN:-app.wathaiqihealth.com}"
BUCKET="${BUCKET:-${PROJECT_ID}-healthdocs-private}"

ADDRESS="${ADDRESS:-wathaiqi-app-ip}"
NEG="${NEG:-wathaiqi-app-neg}"
BACKEND="${BACKEND:-wathaiqi-app-backend}"
URL_MAP="${URL_MAP:-wathaiqi-app-map}"
CERTIFICATE="${CERTIFICATE:-wathaiqi-app-cert}"
SSL_POLICY="${SSL_POLICY:-wathaiqi-tls}"
HTTPS_PROXY="${HTTPS_PROXY:-wathaiqi-app-https}"
FORWARDING_RULE="${FORWARDING_RULE:-wathaiqi-app-https-rule}"
DOMAIN_CONFIRM="${DOMAIN_CONFIRM:-}"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

pending() {
  echo "PENDING: $*" >&2
  exit 2
}

resource_name() {
  local value="$1"
  printf '%s\n' "${value##*/}"
}

assert_equal() {
  local label="$1"
  local actual="$2"
  local expected="$3"
  [[ "${actual}" == "${expected}" ]] || \
    die "${label} is '${actual}', expected '${expected}'. Refusing to modify a conflicting resource."
}

require_single_resource_name() {
  local label="$1"
  local raw_values="$2"
  local expected="$3"
  local normalized="${raw_values//;/ }"
  local count=0
  local value

  for value in ${normalized}; do
    count=$((count + 1))
    assert_equal "${label}" "$(resource_name "${value}")" "${expected}"
  done
  [[ "${count}" -eq 1 ]] || \
    die "${label} must contain exactly one reviewed resource; found ${count}."
}

for required_command in gcloud curl python3 grep mktemp; do
  command -v "${required_command}" >/dev/null || \
    die "${required_command} is required; run this script in Google Cloud Shell."
done

[[ "${REGION}" == "me-central2" ]] || \
  die "Production domain deployment is restricted to me-central2 (Dammam)."
[[ "${DOMAIN}" == "app.wathaiqihealth.com" ]] || \
  die "DOMAIN must be the reviewed hostname app.wathaiqihealth.com."
[[ "${DOMAIN_CONFIRM}" == "CONNECT_app.wathaiqihealth.com" ]] || \
  die "Set DOMAIN_CONFIRM=CONNECT_app.wathaiqihealth.com to approve billable load-balancer resources and the final ingress change."

# Billing/project checks run before enabling an API or creating a paid resource.
bash infra/gcp/preflight.sh
gcloud config set project "${PROJECT_ID}" >/dev/null

SERVICE_URL="$(gcloud run services describe "${SERVICE}" \
  --region="${REGION}" --format='value(status.url)' 2>/dev/null)" || \
  die "Cloud Run service ${SERVICE} does not exist in ${REGION}; run bootstrap.sh first."
LATEST_READY_REVISION="$(gcloud run services describe "${SERVICE}" \
  --region="${REGION}" --format='value(status.latestReadyRevisionName)')"
[[ -n "${LATEST_READY_REVISION}" ]] || \
  die "Cloud Run service ${SERVICE} has no ready revision."

# The browser application is public at the network edge and protects private
# routes with application authentication/RBAC. The HTTPS load balancer cannot
# reach a service that lacks the allUsers Run Invoker binding.
if ! gcloud run services get-iam-policy "${SERVICE}" --region="${REGION}" \
  --format=json | python3 -c '
import json, sys
policy = json.load(sys.stdin)
ok = any(
    binding.get("role") == "roles/run.invoker"
    and "allUsers" in binding.get("members", [])
    for binding in policy.get("bindings", [])
)
raise SystemExit(0 if ok else 1)
'; then
  die "Cloud Run must retain roles/run.invoker for allUsers so the public login and load balancer work."
fi

# Reject an incorrectly placed or publicly exposed document bucket before
# attaching the production domain.
if ! gcloud storage buckets describe "gs://${BUCKET}" --format=json | \
  python3 -c '
import json, sys
expected_region = sys.argv[1].upper()
bucket = json.load(sys.stdin)
iam = bucket.get("iamConfiguration") or bucket.get("iam_configuration") or {}
uble = iam.get("uniformBucketLevelAccess") or iam.get("uniform_bucket_level_access") or {}
location = str(bucket.get("location", "")).upper()
pap = (
    iam.get("publicAccessPrevention")
    or iam.get("public_access_prevention")
    or bucket.get("public_access_prevention")
)
uniform = uble.get("enabled")
if uniform is None:
    uniform = bucket.get("uniform_bucket_level_access")
ok = location == expected_region and str(pap).lower() == "enforced" and uniform is True
raise SystemExit(0 if ok else 1)
' "${REGION}"; then
  die "Bucket ${BUCKET} must exist in ${REGION} with public access prevention and uniform bucket-level access enabled."
fi

# Before creating edge resources, prove that either the generated acceptance
# URL or an existing custom-domain route reaches the ready application.
PRE_EDGE_READY=false
if [[ -n "${SERVICE_URL}" ]] && curl --fail --silent --show-error \
  --retry 3 --retry-delay 3 "${SERVICE_URL%/}/api/readyz" >/dev/null 2>&1; then
  PRE_EDGE_READY=true
elif curl --fail --silent --show-error --retry 3 --retry-delay 3 \
  "https://${DOMAIN}/api/readyz" >/dev/null 2>&1; then
  PRE_EDGE_READY=true
fi
[[ "${PRE_EDGE_READY}" == "true" ]] || \
  die "Neither the run.app acceptance URL nor https://${DOMAIN} reaches /api/readyz."

gcloud services enable compute.googleapis.com >/dev/null

if gcloud compute addresses describe "${ADDRESS}" --global >/dev/null 2>&1; then
  assert_equal "Address type" \
    "$(gcloud compute addresses describe "${ADDRESS}" --global --format='value(addressType)')" \
    "EXTERNAL"
else
  gcloud compute addresses create "${ADDRESS}" \
    --global \
    --ip-version=IPV4 \
    --description="Watha'iqi Health production application"
fi
RESERVED_IP="$(gcloud compute addresses describe "${ADDRESS}" \
  --global --format='value(address)')"
[[ -n "${RESERVED_IP}" ]] || die "Reserved global IP address is empty."

if gcloud compute network-endpoint-groups describe "${NEG}" \
  --region="${REGION}" >/dev/null 2>&1; then
  assert_equal "NEG type" \
    "$(gcloud compute network-endpoint-groups describe "${NEG}" --region="${REGION}" --format='value(networkEndpointType)')" \
    "SERVERLESS"
  assert_equal "NEG Cloud Run service" \
    "$(gcloud compute network-endpoint-groups describe "${NEG}" --region="${REGION}" --format='value(cloudRun.service)')" \
    "${SERVICE}"
else
  gcloud compute network-endpoint-groups create "${NEG}" \
    --region="${REGION}" \
    --network-endpoint-type=serverless \
    --cloud-run-service="${SERVICE}"
fi

if gcloud compute backend-services describe "${BACKEND}" --global >/dev/null 2>&1; then
  assert_equal "Backend load-balancing scheme" \
    "$(gcloud compute backend-services describe "${BACKEND}" --global --format='value(loadBalancingScheme)')" \
    "EXTERNAL_MANAGED"
  assert_equal "Backend protocol" \
    "$(gcloud compute backend-services describe "${BACKEND}" --global --format='value(protocol)')" \
    "HTTP"
  CDN_ENABLED="$(gcloud compute backend-services describe "${BACKEND}" --global --format='value(enableCDN)')"
  [[ -z "${CDN_ENABLED}" || "${CDN_ENABLED,,}" == "false" ]] || \
    die "Cloud CDN must remain disabled for authenticated workforce pages."
else
  gcloud compute backend-services create "${BACKEND}" \
    --global \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --protocol=HTTP \
    --no-enable-cdn
fi

BACKEND_GROUPS="$(gcloud compute backend-services describe "${BACKEND}" \
  --global --format='value(backends[].group)')"
if [[ -z "${BACKEND_GROUPS}" ]]; then
  gcloud compute backend-services add-backend "${BACKEND}" \
    --global \
    --network-endpoint-group="${NEG}" \
    --network-endpoint-group-region="${REGION}"
else
  require_single_resource_name "Backend NEG" "${BACKEND_GROUPS}" "${NEG}"
fi

if gcloud compute url-maps describe "${URL_MAP}" --global >/dev/null 2>&1; then
  if ! gcloud compute url-maps describe "${URL_MAP}" --global --format=json | \
    python3 -c '
import json, sys
expected = sys.argv[1]
url_map = json.load(sys.stdin)
default_service = str(url_map.get("defaultService", "")).rsplit("/", 1)[-1]
no_extra_routes = not url_map.get("hostRules") and not url_map.get("pathMatchers")
raise SystemExit(0 if default_service == expected and no_extra_routes else 1)
' "${BACKEND}"; then
    die "URL map must use only ${BACKEND} as its default service and contain no unreviewed host/path routes."
  fi
else
  gcloud compute url-maps create "${URL_MAP}" \
    --global \
    --default-service="${BACKEND}"
fi

if gcloud compute ssl-policies describe "${SSL_POLICY}" --global >/dev/null 2>&1; then
  assert_equal "TLS profile" \
    "$(gcloud compute ssl-policies describe "${SSL_POLICY}" --global --format='value(profile)')" \
    "MODERN"
  MIN_TLS="$(gcloud compute ssl-policies describe "${SSL_POLICY}" --global --format='value(minTlsVersion)')"
  [[ "${MIN_TLS}" == "TLS_1_2" || "${MIN_TLS}" == "1.2" ]] || \
    die "SSL policy minimum TLS is ${MIN_TLS}; expected TLS 1.2."
else
  gcloud compute ssl-policies create "${SSL_POLICY}" \
    --global \
    --profile=MODERN \
    --min-tls-version=1.2
fi

if gcloud compute ssl-certificates describe "${CERTIFICATE}" --global >/dev/null 2>&1; then
  CERTIFICATE_TYPE="$(gcloud compute ssl-certificates describe "${CERTIFICATE}" --global --format='value(type)')"
  assert_equal "Certificate type" "${CERTIFICATE_TYPE}" "MANAGED"
  CERTIFICATE_DOMAINS="$(gcloud compute ssl-certificates describe "${CERTIFICATE}" --global --format='value(managed.domains[])')"
  require_single_resource_name "Managed certificate domain" "${CERTIFICATE_DOMAINS}" "${DOMAIN}"
else
  gcloud compute ssl-certificates create "${CERTIFICATE}" \
    --global \
    --domains="${DOMAIN}" \
    --description="Watha'iqi Health production application"
fi

if gcloud compute target-https-proxies describe "${HTTPS_PROXY}" --global >/dev/null 2>&1; then
  assert_equal "HTTPS proxy URL map" \
    "$(resource_name "$(gcloud compute target-https-proxies describe "${HTTPS_PROXY}" --global --format='value(urlMap)')")" \
    "${URL_MAP}"
  assert_equal "HTTPS proxy SSL policy" \
    "$(resource_name "$(gcloud compute target-https-proxies describe "${HTTPS_PROXY}" --global --format='value(sslPolicy)')")" \
    "${SSL_POLICY}"
  PROXY_CERTIFICATES="$(gcloud compute target-https-proxies describe "${HTTPS_PROXY}" --global --format='value(sslCertificates[])')"
  require_single_resource_name "HTTPS proxy certificate" "${PROXY_CERTIFICATES}" "${CERTIFICATE}"
else
  gcloud compute target-https-proxies create "${HTTPS_PROXY}" \
    --global \
    --url-map="${URL_MAP}" \
    --ssl-certificates="${CERTIFICATE}" \
    --ssl-policy="${SSL_POLICY}"
fi

if gcloud compute forwarding-rules describe "${FORWARDING_RULE}" --global >/dev/null 2>&1; then
  assert_equal "Forwarding-rule IP" \
    "$(gcloud compute forwarding-rules describe "${FORWARDING_RULE}" --global --format='value(IPAddress)')" \
    "${RESERVED_IP}"
  assert_equal "Forwarding-rule scheme" \
    "$(gcloud compute forwarding-rules describe "${FORWARDING_RULE}" --global --format='value(loadBalancingScheme)')" \
    "EXTERNAL_MANAGED"
  assert_equal "Forwarding-rule protocol" \
    "$(gcloud compute forwarding-rules describe "${FORWARDING_RULE}" --global --format='value(IPProtocol)')" \
    "TCP"
  FORWARDING_PORT="$(gcloud compute forwarding-rules describe "${FORWARDING_RULE}" --global --format='value(portRange)')"
  [[ "${FORWARDING_PORT}" == "443" || "${FORWARDING_PORT}" == "443-443" ]] || \
    die "Forwarding rule exposes '${FORWARDING_PORT}', expected HTTPS port 443 only."
  assert_equal "Forwarding-rule target" \
    "$(resource_name "$(gcloud compute forwarding-rules describe "${FORWARDING_RULE}" --global --format='value(target)')")" \
    "${HTTPS_PROXY}"
else
  gcloud compute forwarding-rules create "${FORWARDING_RULE}" \
    --global \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --target-https-proxy="${HTTPS_PROXY}" \
    --address="${ADDRESS}" \
    --ports=443
fi

echo "Reserved production IP: ${RESERVED_IP}"
echo "Required Squarespace DNS record: A  app  ${RESERVED_IP}"

if ! python3 -c '
import socket, sys
domain, expected = sys.argv[1:]
try:
    addresses = {item[4][0] for item in socket.getaddrinfo(domain, 443, type=socket.SOCK_STREAM)}
except socket.gaierror:
    addresses = set()
raise SystemExit(0 if expected in addresses else 1)
' "${DOMAIN}" "${RESERVED_IP}"; then
  pending "Create or correct the DNS A record above, wait for propagation, then rerun this same command. Cloud Run ingress was not restricted."
fi

CERTIFICATE_JSON="$(gcloud compute ssl-certificates describe "${CERTIFICATE}" --global --format=json)"
if ! printf '%s' "${CERTIFICATE_JSON}" | python3 -c '
import json, sys
domain = sys.argv[1]
certificate = json.load(sys.stdin)
managed = certificate.get("managed") or {}
domain_status = managed.get("domainStatus") or {}
active = managed.get("status") == "ACTIVE"
if domain_status:
    active = active and domain_status.get(domain) == "ACTIVE"
raise SystemExit(0 if active else 1)
' "${DOMAIN}"; then
  CERTIFICATE_STATUS="$(gcloud compute ssl-certificates describe "${CERTIFICATE}" --global --format='value(managed.status)')"
  pending "Managed certificate status is ${CERTIFICATE_STATUS:-unknown}. Wait for ACTIVE, then rerun. Cloud Run ingress was not restricted."
fi

# Only after DNS and the certificate are active do we make the new hostname
# canonical and replace the bucket CORS allowlist with that exact origin.
gcloud run services update "${SERVICE}" \
  --region="${REGION}" \
  --update-env-vars="PUBLIC_APP_URL=https://${DOMAIN},APP_ORIGINS=https://${DOMAIN}" >/dev/null

CORS_FILE="$(mktemp)"
trap 'rm -f "${CORS_FILE}"' EXIT
printf '[{"origin":["https://%s"],"method":["PUT"],"responseHeader":["Content-Type","x-goog-if-generation-match"],"maxAgeSeconds":900}]' \
  "${DOMAIN}" > "${CORS_FILE}"
gcloud storage buckets update "gs://${BUCKET}" --cors-file="${CORS_FILE}" >/dev/null

curl --fail --silent --show-error --retry 6 --retry-delay 5 \
  "https://${DOMAIN}/api/readyz" >/dev/null || \
  die "Custom-domain readiness failed. The run.app URL and ingress remain available for recovery."

# The custom-domain route is now proven. Prevent clients from bypassing the
# load balancer and its TLS policy via the generated Cloud Run URL.
if ! gcloud run services update "${SERVICE}" \
  --region="${REGION}" \
  --ingress=internal-and-cloud-load-balancing \
  --no-default-url >/dev/null; then
  die "Cloud Run ingress restriction failed; the proven custom-domain route was not declared complete."
fi

if ! curl --fail --silent --show-error --retry 6 --retry-delay 5 \
  "https://${DOMAIN}/api/readyz" >/dev/null; then
  echo "WARNING: readiness failed after ingress restriction; restoring the run.app recovery path." >&2
  if gcloud run services update "${SERVICE}" \
    --region="${REGION}" \
    --ingress=all \
    --default-url >/dev/null; then
    die "Custom-domain readiness failed after restriction. Cloud Run ingress/default URL were restored automatically."
  fi
  die "Custom-domain readiness failed and automatic Cloud Run recovery also failed; use the documented operator recovery command immediately."
fi

printf '\nProduction domain connected successfully: https://%s\n' "${DOMAIN}"
printf 'Cloud Run is restricted to internal and load-balancer ingress; the run.app default URL is disabled.\n'
