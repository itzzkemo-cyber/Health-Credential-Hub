# Employee invitation SMS OTP

Employee accounts are still administrator-provisioned. The SMS flow proves
control of the Saudi mobile number that the administrator stored on the
invitation; it does not permit public self-registration or any choice of role,
facility, department, or supervisor.

## Data flow and retention

- The API sends only the invitation mobile number in `+9665XXXXXXXX` E.164
  format to Twilio Verify. It does not send the employee name, email, facility,
  job title, invitation token, or password.
- Twilio creates and checks the OTP. The application never receives or stores a
  plaintext generated OTP. It sends the employee-entered code to Twilio only
  for verification.
- PostgreSQL stores the invitation phone, provider name, the non-PII Twilio
  Verification SID that binds each code check to its exact send, timestamps,
  send and attempt counters, and terminal status. After provider approval it briefly
  stores a non-recoverable HMAC proof keyed by the raw invitation token so a
  database failure can be retried only with the same invitation, phone, and
  code. The raw token and code are never stored; the proof is cleared when the
  challenge is consumed. A successful activation stores
  `users.phone_verified_at` and consumes the challenge in the same transaction
  that creates the employee. Invitation retention cleanup cascades to its OTP
  challenge.
- Provider region, data residency, subprocessor terms, messaging retention,
  Saudi sender registration, and DPA approval are operator/compliance choices;
  they must be accepted before production enablement.

## Reliability and abuse controls

- Provider calls time out after 10 seconds and fail closed. They are not
  automatically retried because an ambiguous send retry could deliver duplicate
  messages; the employee may explicitly retry after the durable cooldown.
- One invitation can request at most five sends per rolling hour with a
  60-second cooldown. Each issued challenge expires locally after 10 minutes
  and permits five verification attempts.
- A durable 30-second verification lease serializes parallel code checks. Code
  checks use the exact Twilio Verification SID returned for that invitation,
  so simultaneous invitations for one phone number cannot cross-match.
  Provider approval is persisted before password hashing/finalization;
  successful challenges are single-use and are consumed atomically with the
  invitation. Public per-IP limits provide an additional safety layer.
- Provider errors are logged only with a bounded error class and internal
  challenge ID. Phone numbers, OTPs, credentials, response bodies, and bearer
  tokens are never logged.

## Production setup

1. Create a restricted Twilio API key and Verify service. Configure the Verify
   code lifetime to no more than 10 minutes and enable provider fraud controls.
2. Complete Saudi messaging/sender registration and confirm the exact provider
   region and contractual terms with the privacy owner.
3. Store `TWILIO_API_KEY_SECRET` in the deployment secret manager and configure
   the remaining placeholders from `.env.example`. Set
   `SMS_OTP_PROVIDER=twilio_verify` only after the service is approved.
4. Apply the reviewed database migration before deploying the API and web app.
5. Exercise send, wrong-code, expiry, resend cooldown, replay, and provider
   outage cases using a non-production facility and recipient.
