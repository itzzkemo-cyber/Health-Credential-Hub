import { createHash } from "node:crypto";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RAW_TOKEN = "a".repeat(64);
const TOKEN_HASH = createHash("sha256").update(RAW_TOKEN).digest("hex");

const state = vi.hoisted(() => ({
  invitation: null as Record<string, any> | null,
  inviter: null as Record<string, any> | null,
  supervisor: null as Record<string, any> | null,
  department: null as Record<string, any> | null,
  challenge: null as Record<string, any> | null,
  challengeUpdate: null as Record<string, unknown> | null,
  facilityRows: [{ id: 10 }] as Array<Record<string, unknown>>,
  existingEmailRows: [] as Array<Record<string, unknown>>,
  userInsert: null as Record<string, unknown> | null,
  invitationUpdate: null as Record<string, unknown> | null,
  auditInsert: null as Record<string, unknown> | null,
  outsideRevocation: false,
  uniqueRace: false,
  finalizationFailureOnce: false,
  transactionCount: 0,
  hashPassword: vi.fn(async (_password: string) => "new-password-hash"),
  setSessionCookie: vi.fn(),
  smsConfigured: true,
  startPhoneOtp: vi.fn(async (): Promise<string> => `VE${"b".repeat(32)}`),
  checkPhoneOtp: vi.fn(
    async (): Promise<"approved" | "rejected"> => "approved",
  ),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  gt: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  inArray: vi.fn((column: unknown, values: unknown[]) => ({ column, values })),
  isNull: vi.fn((column: unknown) => ({ column, isNull: true })),
  sql: vi.fn(() => ({ kind: "sql" })),
}));

vi.mock("@workspace/db", () => {
  const employeeInvitationsTable = {
    kind: "employeeInvitations",
    id: "employeeInvitations.id",
    tokenHash: "employeeInvitations.tokenHash",
    email: "employeeInvitations.email",
    acceptedAt: "employeeInvitations.acceptedAt",
    revokedAt: "employeeInvitations.revokedAt",
    expiresAt: "employeeInvitations.expiresAt",
  };
  const usersTable = {
    kind: "users",
    id: "users.id",
    email: "users.email",
    sessionVersion: "users.sessionVersion",
    backupCodes: "users.backupCodes",
    totpLastUsedStep: "users.totpLastUsedStep",
  };
  const departmentsTable = {
    kind: "departments",
    id: "departments.id",
    facilityId: "departments.facilityId",
    deletedAt: "departments.deletedAt",
  };
  const facilitiesTable = { kind: "facilities", id: "facilities.id" };
  const phoneOtpChallengesTable = {
    kind: "phoneOtpChallenges",
    id: "phoneOtpChallenges.id",
    invitationId: "phoneOtpChallenges.invitationId",
    status: "phoneOtpChallenges.status",
    providerVerificationSid: "phoneOtpChallenges.providerVerificationSid",
    attemptCount: "phoneOtpChallenges.attemptCount",
    expiresAt: "phoneOtpChallenges.expiresAt",
    consumedAt: "phoneOtpChallenges.consumedAt",
  };
  const auditLogsTable = { kind: "auditLogs" };

  const outsideUpdate = (table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        if (table === employeeInvitationsTable) state.outsideRevocation = true;
        if (table === phoneOtpChallengesTable) {
          const appliedValues =
            values.attemptCount && typeof values.attemptCount === "object"
              ? {
                  ...values,
                  attemptCount: Math.max(
                    Number(state.challenge?.attemptCount ?? 0) - 1,
                    0,
                  ),
                }
              : values;
          state.challengeUpdate = appliedValues;
          if (state.challenge) Object.assign(state.challenge, appliedValues);
        }
        const terminal = Promise.resolve(undefined);
        return {
          then: terminal.then.bind(terminal),
          returning: async () => [{ id: state.challenge?.id ?? 51 }],
        };
      },
    }),
  });

  return {
    employeeInvitationsTable,
    usersTable,
    departmentsTable,
    facilitiesTable,
    phoneOtpChallengesTable,
    auditLogsTable,
    passwordResetTokensTable: {},
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(async () => []) })),
      })),
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
      update: vi.fn(outsideUpdate),
      transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => {
        state.transactionCount += 1;
        const tx = {
          execute: vi.fn(async () => undefined),
          select: (_selection?: unknown) => ({
            from: (table: unknown) => ({
              where: (condition: unknown) => {
                if (table === employeeInvitationsTable) {
                  const rows = state.invitation ? [state.invitation] : [];
                  const terminal = Promise.resolve(rows);
                  return {
                    then: terminal.then.bind(terminal),
                    for: async () => rows,
                  };
                }
                if (table === departmentsTable) {
                  return {
                    for: async () =>
                      state.department ? [state.department] : [],
                  };
                }
                if (table === usersTable) {
                  if (
                    typeof condition === "object" &&
                    condition !== null &&
                    "values" in condition
                  ) {
                    const ids = (condition as { values: number[] }).values;
                    const users = [state.inviter, state.supervisor]
                      .filter((value): value is Record<string, any> =>
                        Boolean(value),
                      )
                      .filter((user) => ids.includes(user.id as number))
                      .sort(
                        (left, right) =>
                          (left.id as number) - (right.id as number),
                      );
                    return { orderBy: () => ({ for: async () => users }) };
                  }
                  return Promise.resolve(state.existingEmailRows);
                }
                if (table === facilitiesTable) {
                  return Promise.resolve(state.facilityRows);
                }
                if (table === phoneOtpChallengesTable) {
                  return {
                    for: async () => (state.challenge ? [state.challenge] : []),
                  };
                }
                throw new Error("Unexpected select table");
              },
            }),
          }),
          insert: (table: unknown) => ({
            values: (values: Record<string, unknown>) => {
              if (table === usersTable) {
                state.userInsert = values;
                return {
                  returning: async () => {
                    if (state.uniqueRace) {
                      throw Object.assign(new Error("query failed"), {
                        cause: Object.assign(new Error("private detail"), {
                          code: "23505",
                        }),
                      });
                    }
                    if (state.finalizationFailureOnce) {
                      state.finalizationFailureOnce = false;
                      throw new Error("finalization failed");
                    }
                    return [
                      {
                        id: 22,
                        ...values,
                        createdAt: new Date("2026-08-28T00:00:00.000Z"),
                      },
                    ];
                  },
                };
              }
              if (table === auditLogsTable) {
                state.auditInsert = values;
                return Promise.resolve();
              }
              if (table === phoneOtpChallengesTable) {
                state.challenge = {
                  id: 51,
                  createdAt: new Date(),
                  ...values,
                };
                return {
                  returning: async () => [{ id: 51 }],
                };
              }
              throw new Error("Unexpected insert table");
            },
          }),
          update: (table: unknown) => ({
            set: (values: Record<string, unknown>) => ({
              where: () => {
                if (table === phoneOtpChallengesTable) {
                  state.challengeUpdate = values;
                  if (state.challenge) Object.assign(state.challenge, values);
                  const terminal = Promise.resolve(undefined);
                  return {
                    then: terminal.then.bind(terminal),
                    returning: async () => [{ id: state.challenge?.id ?? 51 }],
                  };
                }
                if (table !== employeeInvitationsTable) {
                  throw new Error("Unexpected update table");
                }
                state.invitationUpdate = values;
                const terminal = Promise.resolve(undefined);
                return {
                  then: terminal.then.bind(terminal),
                  returning: async () => [{ id: state.invitation?.id ?? 81 }],
                };
              },
            }),
          }),
        };
        return callback(tx);
      }),
    },
  };
});

vi.mock("../lib/auth", () => ({
  ADMIN_ROLES: ["hospital_admin", "system_admin"],
  signToken: vi.fn(),
  signPurposeToken: vi.fn(),
  createTwoFactorChallengeToken: vi.fn(),
  verifyPurposeToken: vi.fn(),
  comparePassword: vi.fn(),
  hashPassword: state.hashPassword,
  setSessionCookie: state.setSessionCookie,
  clearSessionCookie: vi.fn(),
  getUser: vi.fn(),
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) =>
    next(),
}));

vi.mock("../lib/rateLimit", () => ({
  rateLimit: () => (_req: Request, _res: Response, next: NextFunction) =>
    next(),
}));

vi.mock("../lib/csrf", () => ({
  sessionIssuanceCsrfGuard: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

vi.mock("../lib/helpers", () => ({
  serializeUser: vi.fn(),
  logAudit: vi.fn(async () => undefined),
  syncExpiryNotifications: vi.fn(async () => undefined),
}));

vi.mock("../lib/totp", () => ({
  generateTotpSecret: vi.fn(),
  buildOtpauthUrl: vi.fn(),
  verifyOtp: vi.fn(),
  generateBackupCodes: vi.fn(),
}));

vi.mock("../lib/totpSecret", () => ({
  encryptTotpSecret: vi.fn(),
}));

vi.mock("../lib/secondFactor", () => ({
  consumeSecondFactor: vi.fn(),
}));

vi.mock("../lib/sessionFreshness", () => ({
  isFreshActiveSessionActor: vi.fn(() => true),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../lib/email/sender", () => ({
  EmailNotConfiguredError: class extends Error {},
  createEmailIdempotencyKey: vi.fn(),
  isEmailConfigured: vi.fn(() => false),
  isFixtureRecipient: vi.fn(() => false),
  sendEmail: vi.fn(),
}));

vi.mock("../lib/email/templates", () => ({
  getPasswordResetUrl: vi.fn(),
  passwordResetEmail: vi.fn(),
}));

vi.mock("../lib/safeError", () => ({
  safeErrorLogFields: vi.fn(() => ({})),
}));

vi.mock("../lib/sms/provider", () => ({
  SmsOtpNotConfiguredError: class extends Error {},
  isSmsOtpConfigured: vi.fn(() => state.smsConfigured),
  startPhoneOtp: state.startPhoneOtp,
  checkPhoneOtp: state.checkPhoneOtp,
}));

import router from "./auth";

describe("public employee invitation acceptance", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    state.invitation = {
      id: 81,
      tokenHash: TOKEN_HASH,
      email: "new.worker@example.sa",
      invitedBy: 1,
      facilityId: 10,
      departmentId: 7,
      supervisorId: 3,
      name: "New Worker",
      nameAr: "موظف جديد",
      jobTitle: "Nurse",
      jobTitleAr: "ممرض",
      employeeNumber: "EMP-2",
      phone: "+966500000000",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      revokedAt: null,
      acceptedAt: null,
    };
    state.inviter = {
      id: 1,
      role: "hospital_admin",
      facilityId: 10,
      isActive: true,
    };
    state.supervisor = {
      id: 3,
      role: "supervisor",
      facilityId: 10,
      isActive: true,
    };
    state.department = { id: 7, facilityId: 10 };
    state.challenge = {
      id: 51,
      invitationId: 81,
      provider: "twilio_verify",
      providerVerificationSid: `VE${"b".repeat(32)}`,
      status: "pending",
      sendCount: 1,
      sendWindowStartedAt: new Date(),
      attemptCount: 0,
      dispatchStartedAt: null,
      verificationStartedAt: null,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      nextSendAt: new Date(Date.now() + 60_000),
      verifiedAt: null,
      approvalProofHash: null,
      consumedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    state.facilityRows = [{ id: 10 }];
    state.existingEmailRows = [];
    state.userInsert = null;
    state.invitationUpdate = null;
    state.auditInsert = null;
    state.challengeUpdate = null;
    state.outsideRevocation = false;
    state.uniqueRace = false;
    state.finalizationFailureOnce = false;
    state.transactionCount = 0;
    state.hashPassword.mockClear();
    state.setSessionCookie.mockClear();
    state.smsConfigured = true;
    state.checkPhoneOtp.mockReset();
    state.checkPhoneOtp.mockResolvedValue("approved");
    state.startPhoneOtp.mockReset();
    state.startPhoneOtp.mockResolvedValue(`VE${"b".repeat(32)}`);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });

  async function accept(
    overrides: Record<string, unknown> = {},
  ): Promise<globalThis.Response> {
    const app = express();
    app.use(express.json());
    app.use("/api", router);
    app.use(
      (_error: unknown, _req: Request, res: Response, _next: NextFunction) =>
        res.status(500).json({ message: "Internal server error" }),
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    return fetch(
      `http://127.0.0.1:${address.port}/api/auth/accept-invitation`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "HealthCredentialHub",
        },
        body: JSON.stringify({
          token: RAW_TOKEN,
          password: "  strong password  ",
          phone: "+966500000000",
          code: "123456",
          ...overrides,
        }),
      },
    );
  }

  async function startOtp(
    overrides: Record<string, unknown> = {},
  ): Promise<globalThis.Response> {
    const app = express();
    app.use(express.json());
    app.use("/api", router);
    app.use(
      (_error: unknown, _req: Request, res: Response, _next: NextFunction) =>
        res.status(500).json({ message: "Internal server error" }),
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    return fetch(
      `http://127.0.0.1:${address.port}/api/auth/invitation-phone-otp/start`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "HealthCredentialHub",
        },
        body: JSON.stringify({
          token: RAW_TOKEN,
          phone: "+966500000000",
          ...overrides,
        }),
      },
    );
  }

  it("creates only the authoritative employee profile atomically and issues no session", async () => {
    const response = await accept();

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(
      expect.objectContaining({ success: true }),
    );
    expect(state.hashPassword).toHaveBeenCalledWith("  strong password  ");
    expect(state.userInsert).toEqual({
      email: "new.worker@example.sa",
      passwordHash: "new-password-hash",
      name: "New Worker",
      nameAr: "موظف جديد",
      role: "employee",
      departmentId: 7,
      supervisorId: 3,
      facilityId: 10,
      jobTitle: "Nurse",
      jobTitleAr: "ممرض",
      employeeNumber: "EMP-2",
      phone: "+966500000000",
      phoneVerifiedAt: expect.any(Date),
      isActive: true,
      mustChangePassword: false,
      sessionVersion: 1,
    });
    expect(state.invitationUpdate).toEqual(
      expect.objectContaining({
        acceptedAt: expect.any(Date),
        acceptedUserId: 22,
      }),
    );
    expect(state.auditInsert).toEqual(
      expect.objectContaining({
        userId: 22,
        facilityId: 10,
        action: "Accepted employee invitation",
      }),
    );
    expect(state.setSessionCookie).not.toHaveBeenCalled();
    expect(state.challenge).toEqual(
      expect.objectContaining({
        status: "consumed",
        verifiedAt: expect.any(Date),
        consumedAt: expect.any(Date),
      }),
    );
  });

  it("persists a challenge before sending an OTP and activates it only after provider success", async () => {
    state.challenge = null;

    const response = await startOtp();

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "sent",
      expiresInSeconds: 600,
      retryAfterSeconds: 60,
    });
    expect(state.startPhoneOtp).toHaveBeenCalledWith("+966500000000");
    expect(state.challenge).toEqual(
      expect.objectContaining({
        invitationId: 81,
        status: "pending",
        providerVerificationSid: `VE${"b".repeat(32)}`,
        attemptCount: 0,
        sendCount: 1,
      }),
    );
  });

  it("does not send an OTP when the inviter no longer has facility authority", async () => {
    state.challenge = null;
    state.inviter!.facilityId = 99;

    const response = await startOtp();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "invalid_invitation" }),
    );
    expect(state.startPhoneOtp).not.toHaveBeenCalled();
    expect(state.challenge).toBeNull();
  });

  it("enforces the persisted resend cooldown across instances", async () => {
    const response = await startOtp();

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        code: "otp_rate_limited",
        retryAfterSeconds: expect.any(Number),
      }),
    );
    expect(state.startPhoneOtp).not.toHaveBeenCalled();
  });

  it("enforces the persisted hourly send budget after the cooldown", async () => {
    state.challenge!.nextSendAt = new Date(Date.now() - 1_000);
    state.challenge!.sendWindowStartedAt = new Date();
    state.challenge!.sendCount = 5;

    const response = await startOtp();

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "otp_rate_limited" }),
    );
    expect(state.startPhoneOtp).not.toHaveBeenCalled();
  });

  it("preserves the attempt budget when resending in the same hourly window", async () => {
    state.challenge!.nextSendAt = new Date(Date.now() - 1_000);
    state.challenge!.sendWindowStartedAt = new Date();
    state.challenge!.sendCount = 1;
    state.challenge!.attemptCount = 2;

    const response = await startOtp();

    expect(response.status).toBe(202);
    expect(state.challenge).toEqual(
      expect.objectContaining({ status: "pending", attemptCount: 2 }),
    );
  });

  it("rejects resend while a verification lease is active", async () => {
    state.challenge!.status = "verifying";
    state.challenge!.verificationStartedAt = new Date();
    state.challenge!.nextSendAt = new Date(Date.now() - 1_000);

    const response = await startOtp();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "otp_operation_in_progress" }),
    );
    expect(state.startPhoneOtp).not.toHaveBeenCalled();
  });

  it("rejects resend while a dispatch lease is active", async () => {
    state.challenge!.status = "dispatching";
    state.challenge!.dispatchStartedAt = new Date();
    state.challenge!.nextSendAt = new Date(Date.now() - 1_000);

    const response = await startOtp();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "otp_operation_in_progress" }),
    );
    expect(state.startPhoneOtp).not.toHaveBeenCalled();
  });

  it("still honors resend cooldown after a verification lease becomes stale", async () => {
    state.challenge!.status = "verifying";
    state.challenge!.verificationStartedAt = new Date(Date.now() - 31_000);
    state.challenge!.nextSendAt = new Date(Date.now() + 30_000);

    const response = await startOtp();

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "otp_rate_limited" }),
    );
    expect(state.startPhoneOtp).not.toHaveBeenCalled();
  });

  it("recovers a stale verification lease without resetting attempts", async () => {
    state.challenge!.status = "verifying";
    state.challenge!.verificationStartedAt = new Date(Date.now() - 31_000);
    state.challenge!.nextSendAt = new Date(Date.now() - 1_000);
    state.challenge!.attemptCount = 2;

    const response = await startOtp();

    expect(response.status).toBe(202);
    expect(state.challenge).toEqual(
      expect.objectContaining({
        status: "pending",
        providerVerificationSid: `VE${"b".repeat(32)}`,
        attemptCount: 2,
      }),
    );
  });

  it("starts a fresh provider verification after an approved challenge expires", async () => {
    state.challenge!.status = "approved";
    state.challenge!.verifiedAt = new Date(Date.now() - 11 * 60_000);
    state.challenge!.approvalProofHash = "c".repeat(64);
    state.challenge!.expiresAt = new Date(Date.now() - 1_000);
    state.challenge!.nextSendAt = new Date(Date.now() - 1_000);

    const response = await startOtp();

    expect(response.status).toBe(202);
    expect(state.startPhoneOtp).toHaveBeenCalledTimes(1);
    expect(state.challenge).toEqual(
      expect.objectContaining({
        status: "pending",
        providerVerificationSid: `VE${"b".repeat(32)}`,
        verifiedAt: null,
        approvalProofHash: null,
      }),
    );
  });

  it("fails closed and marks the challenge failed when SMS delivery fails", async () => {
    state.challenge = null;
    state.startPhoneOtp.mockRejectedValueOnce(new Error("provider failure"));

    const response = await startOtp();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "otp_delivery_failed" }),
    );
    expect(state.challenge).toEqual(
      expect.objectContaining({ status: "failed" }),
    );
    expect(state.userInsert).toBeNull();
  });

  it("does not create a user for a rejected OTP and persists the attempt", async () => {
    state.checkPhoneOtp.mockResolvedValueOnce("rejected");

    const response = await accept({ code: "000000" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "invalid_phone_otp" }),
    );
    expect(state.userInsert).toBeNull();
    expect(state.challenge).toEqual(
      expect.objectContaining({ status: "pending", attemptCount: 1 }),
    );
    expect(state.checkPhoneOtp).toHaveBeenCalledWith(
      `VE${"b".repeat(32)}`,
      "000000",
    );
  });

  it("releases the verification lease without consuming an attempt when the provider fails", async () => {
    state.checkPhoneOtp.mockRejectedValueOnce(new Error("provider failure"));

    const response = await accept();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "otp_provider_failed" }),
    );
    expect(state.userInsert).toBeNull();
    expect(state.challenge).toEqual(
      expect.objectContaining({
        status: "pending",
        attemptCount: 0,
        verificationStartedAt: null,
      }),
    );
  });

  it("rejects an expired persisted OTP without calling the provider", async () => {
    state.challenge!.expiresAt = new Date(Date.now() - 1_000);

    const response = await accept();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "invalid_phone_otp" }),
    );
    expect(state.checkPhoneOtp).not.toHaveBeenCalled();
    expect(state.userInsert).toBeNull();
    expect(state.challenge).toEqual(
      expect.objectContaining({
        status: "failed",
        providerVerificationSid: null,
        dispatchStartedAt: null,
        verificationStartedAt: null,
        verifiedAt: null,
        approvalProofHash: null,
        consumedAt: null,
      }),
    );
  });

  it("sanitizes an expired approved challenge before rejecting it", async () => {
    state.challenge!.status = "approved";
    state.challenge!.verifiedAt = new Date(Date.now() - 11 * 60_000);
    state.challenge!.approvalProofHash = "c".repeat(64);
    state.challenge!.expiresAt = new Date(Date.now() - 1_000);

    const response = await accept();

    expect(response.status).toBe(400);
    expect(state.checkPhoneOtp).not.toHaveBeenCalled();
    expect(state.challenge).toEqual(
      expect.objectContaining({
        status: "failed",
        providerVerificationSid: null,
        verifiedAt: null,
        approvalProofHash: null,
      }),
    );
  });

  it("enforces the persisted OTP attempt budget without calling the provider", async () => {
    state.challenge!.attemptCount = 5;

    const response = await accept();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "invalid_phone_otp" }),
    );
    expect(state.checkPhoneOtp).not.toHaveBeenCalled();
    expect(state.userInsert).toBeNull();
    expect(state.challenge).toEqual(
      expect.objectContaining({ status: "failed", attemptCount: 5 }),
    );
  });

  it("rejects a parallel verification while a durable lease is active", async () => {
    state.challenge!.status = "verifying";
    state.challenge!.verificationStartedAt = new Date();

    const response = await accept();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "otp_verification_in_progress" }),
    );
    expect(state.checkPhoneOtp).not.toHaveBeenCalled();
    expect(state.userInsert).toBeNull();
  });

  it("retries finalization after provider approval without checking the provider twice", async () => {
    state.finalizationFailureOnce = true;

    const firstResponse = await accept();

    expect(firstResponse.status).toBe(500);
    expect(state.challenge).toEqual(
      expect.objectContaining({
        status: "approved",
        approvalProofHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }

    const retryResponse = await accept();

    expect(retryResponse.status).toBe(201);
    expect(state.checkPhoneOtp).toHaveBeenCalledTimes(1);
    expect(state.challenge).toEqual(
      expect.objectContaining({
        status: "consumed",
        providerVerificationSid: null,
        approvalProofHash: null,
        consumedAt: expect.any(Date),
      }),
    );
  });

  it("rejects a different code after provider approval without rechecking the provider", async () => {
    state.finalizationFailureOnce = true;
    const firstResponse = await accept();
    expect(firstResponse.status).toBe(500);
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
    state.userInsert = null;

    const retryResponse = await accept({ code: "654321" });

    expect(retryResponse.status).toBe(400);
    expect(await retryResponse.json()).toEqual(
      expect.objectContaining({ code: "invalid_phone_otp" }),
    );
    expect(state.checkPhoneOtp).toHaveBeenCalledTimes(1);
    expect(state.userInsert).toBeNull();
    expect(state.challenge).toEqual(
      expect.objectContaining({ status: "approved", attemptCount: 2 }),
    );
  });

  it("exhausts the durable budget for mismatched codes after provider approval", async () => {
    state.finalizationFailureOnce = true;
    const firstResponse = await accept();
    expect(firstResponse.status).toBe(500);
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
    state.userInsert = null;

    for (const code of ["654321", "654322", "654323", "654324"]) {
      const response = await accept({ code });
      expect(response.status).toBe(400);
      if (server) {
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
        server = undefined;
      }
    }

    expect(state.checkPhoneOtp).toHaveBeenCalledTimes(1);
    expect(state.userInsert).toBeNull();
    expect(state.challenge).toEqual(
      expect.objectContaining({
        status: "failed",
        attemptCount: 5,
        providerVerificationSid: null,
        verifiedAt: null,
        approvalProofHash: null,
      }),
    );
  });

  it("fails closed when a pending challenge has no provider verification SID", async () => {
    state.challenge!.providerVerificationSid = null;

    const response = await accept();

    expect(response.status).toBe(400);
    expect(state.checkPhoneOtp).not.toHaveBeenCalled();
    expect(state.challenge).toEqual(
      expect.objectContaining({
        status: "failed",
        providerVerificationSid: null,
      }),
    );
  });

  it.each([
    ["expired", { expiresAt: new Date(Date.now() - 1_000) }],
    ["replayed", { acceptedAt: new Date() }],
    ["revoked", { revokedAt: new Date() }],
  ])(
    "returns the same generic response for an %s invitation",
    async (_label, patch) => {
      Object.assign(state.invitation!, patch);

      const response = await accept();

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(
        expect.objectContaining({ code: "invalid_invitation" }),
      );
      expect(state.userInsert).toBeNull();
    },
  );

  it("rejects an overlong invitation password before hashing or database work", async () => {
    const response = await accept({ password: "x".repeat(1025) });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "weak_password" }),
    );
    expect(state.hashPassword).not.toHaveBeenCalled();
    expect(state.transactionCount).toBe(0);
    expect(state.userInsert).toBeNull();
  });

  it.each(["12345", "1234567"])(
    "rejects a non-six-digit SMS code (%s) before database work",
    async (code) => {
      const response = await accept({ code });

      expect(response.status).toBe(400);
      expect(state.transactionCount).toBe(0);
      expect(state.checkPhoneOtp).not.toHaveBeenCalled();
      expect(state.userInsert).toBeNull();
    },
  );

  it("rejects tenant or role injection fields with the generic response", async () => {
    const response = await accept({ facilityId: 99, role: "system_admin" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "invalid_invitation" }),
    );
    expect(state.transactionCount).toBe(0);
    expect(state.userInsert).toBeNull();
  });

  it("invalidates an invitation when the inviter no longer controls its facility", async () => {
    state.inviter!.facilityId = 99;

    const response = await accept();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "invalid_invitation" }),
    );
    expect(state.userInsert).toBeNull();
    expect(state.invitationUpdate).toEqual(
      expect.objectContaining({ revokedAt: expect.any(Date) }),
    );
  });

  it("invalidates an invitation when its supervisor is no longer higher-ranked", async () => {
    state.supervisor!.role = "employee";

    const response = await accept();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "invalid_invitation" }),
    );
    expect(state.userInsert).toBeNull();
    expect(state.invitationUpdate).toEqual(
      expect.objectContaining({ revokedAt: expect.any(Date) }),
    );
  });

  it("maps a raced email uniqueness violation to the generic response and revokes the link", async () => {
    state.uniqueRace = true;

    const response = await accept();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "invalid_invitation" }),
    );
    expect(state.outsideRevocation).toBe(true);
  });
});
