# Employee invitation email OTP

Employee account activation uses an administrator-issued invitation followed
by a six-digit code sent to the invitation email. The API never accepts an OTP
recipient from the browser and never treats email verification as phone
verification.

## Security and data flow

1. An authenticated administrator with a fresh password step-up creates the
   employee invitation. The account selected by `PROTECTED_MFA_USER_ID` must
   additionally provide a current TOTP or backup code. Facility, department,
   supervisor, role, email, and profile fields are authoritative server-side
   values.
2. The invitation email contains a single-use fragment token. On the activation
   page, `POST /api/auth/invitation-email-otp/start` accepts only that token.
3. The API revalidates the invitation, inviter authority, facility, department,
   and supervisor, then takes a durable PostgreSQL dispatch claim.
4. A CSPRNG six-digit code is sent through the configured Resend sender to the
   locked `employee_invitations.email`. No caller-supplied email is accepted.
5. PostgreSQL stores only a random 128-bit salt and a SHA-256 HMAC. The HMAC key
   is derived from `SESSION_SECRET` with an explicit email-OTP domain. The MAC
   also binds the token digest, challenge ID, normalized invitation email,
   salt, and code. Plaintext codes are never stored or logged.
6. Acceptance checks the code with a fixed-length timing-safe comparison under
   a locked durable challenge. User creation, invitation acceptance, OTP
   consumption, and the audit record commit atomically.

## Limits and failure behavior

- Code lifetime: 10 minutes.
- Resend cooldown: 60 seconds.
- Send budget: 5 sends per invitation in one hour.
- Attempt budget: 5 wrong codes per challenge.
- Dispatch lease: 75 seconds, longer than the email adapter's bounded retry
  path. Each send generation has a stable Resend idempotency key.
- Codes and invitations are single use. Retired SMS challenges are failed
  closed by migration `0016_black_silver_centurion.sql`.
- Resend configuration/provider failures do not activate the challenge.
- Rotating `SESSION_SECRET` intentionally invalidates all pending codes; their
  maximum remaining lifetime is ten minutes.
- Email OTP proves control only of the invitation email. An optional phone is
  copied as unverified and `phone_verified_at` remains null.

## Operator setup

1. Verify the dedicated sender domain in Resend and disable click/open tracking.
2. Set `EMAIL_ALERTS_DISABLED=0`, `EMAIL_FROM`, `RESEND_API_KEY`, and the HTTPS
   `PUBLIC_APP_URL` in the deployment secret manager.
3. Keep the existing generated high-entropy `SESSION_SECRET` server-only.
4. Apply migrations through `0016`, deploy, and confirm `/api/readyz` reports
   both `emailDelivery` and `invitationEmailOtp` as `configured`.
5. Test send, wrong-code, expired-code, resend cooldown, replay, and successful
   activation with a non-production employee account before rollout.
