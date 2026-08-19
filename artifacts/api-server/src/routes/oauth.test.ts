import express from "express";
import cookieParser from "cookie-parser";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const oauthMocks = vi.hoisted(() => ({
  usersByGoogleId: [] as Array<Record<string, unknown>>,
  usersByEmail: [] as Array<Record<string, unknown>>,
  facilities: [] as Array<Record<string, unknown>>,
  createdUser: null as Record<string, unknown> | null,
  insert: vi.fn(),
  values: vi.fn(),
  returning: vi.fn(),
  setSessionCookie: vi.fn(),
  signToken: vi.fn(() => "session-token"),
  logAudit: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  asc: vi.fn((column: unknown) => ({ ascending: column })),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
}));

vi.mock("@workspace/db", () => {
  const usersTable = {
    googleId: "users.googleId",
    email: "users.email",
  };
  const facilitiesTable = { id: "facilities.id" };
  return {
    usersTable,
    facilitiesTable,
    db: {
      select: vi.fn(() => {
        let table: unknown;
        const query = {
          from: vi.fn((selectedTable: unknown) => {
            table = selectedTable;
            return query;
          }),
          where: vi.fn(
            async (condition: { column: unknown; value: unknown }) => {
              if (table !== usersTable) return [];
              return condition.column === usersTable.googleId
                ? oauthMocks.usersByGoogleId
                : oauthMocks.usersByEmail;
            },
          ),
          orderBy: vi.fn(() => query),
          limit: vi.fn(async () =>
            table === facilitiesTable ? oauthMocks.facilities : [],
          ),
        };
        return query;
      }),
      insert: oauthMocks.insert,
    },
  };
});

vi.mock("../lib/auth", () => ({
  createTwoFactorChallengeToken: vi.fn(() => "challenge-token"),
  hashPassword: vi.fn(async () => "hashed-placeholder"),
  setSessionCookie: oauthMocks.setSessionCookie,
  signPurposeToken: vi.fn(() => "state-token"),
  signToken: oauthMocks.signToken,
  verifyPurposeToken: vi.fn(() => ({ n: "browser-nonce" })),
}));

vi.mock("../lib/helpers", () => ({
  logAudit: oauthMocks.logAudit,
  syncExpiryNotifications: vi.fn(async () => undefined),
}));

vi.mock("../lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../lib/rateLimit", () => ({
  rateLimit:
    () =>
    (
      _req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ) =>
      next(),
}));

vi.mock("../lib/publicUrl", () => ({
  getPublicAppUrl: vi.fn(() => "https://credentials.example.sa"),
}));

import router from "./oauth";

const nativeFetch = globalThis.fetch.bind(globalThis);

const linkedUser = {
  id: 5,
  email: "worker@example.sa",
  googleId: "google-subject",
  isActive: true,
  totpEnabled: false,
  totpSecret: null,
  sessionVersion: 0,
  facilityId: 10,
};

function mockGoogleProfile(email = "worker@example.sa"): void {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith("http://127.0.0.1:")) {
      return nativeFetch(input, init);
    }
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "access-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "https://www.googleapis.com/oauth2/v3/userinfo") {
      return new Response(
        JSON.stringify({
          sub: "google-subject",
          email,
          email_verified: true,
          name: "Test Worker",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
}

describe("Google OAuth account matching", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalClientId = process.env.GOOGLE_CLIENT_ID;
  const originalClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const originalAutoProvision = process.env.GOOGLE_AUTO_PROVISION_ENABLED;

  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.GOOGLE_CLIENT_ID = "test-client";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    delete process.env.GOOGLE_AUTO_PROVISION_ENABLED;
    oauthMocks.usersByGoogleId = [];
    oauthMocks.usersByEmail = [];
    oauthMocks.facilities = [];
    oauthMocks.createdUser = null;
    for (const mock of [
      oauthMocks.insert,
      oauthMocks.values,
      oauthMocks.returning,
      oauthMocks.setSessionCookie,
      oauthMocks.signToken,
      oauthMocks.logAudit,
    ]) {
      mock.mockClear();
    }
    oauthMocks.insert.mockReturnValue({ values: oauthMocks.values });
    oauthMocks.values.mockReturnValue({ returning: oauthMocks.returning });
    oauthMocks.returning.mockImplementation(async () =>
      oauthMocks.createdUser ? [oauthMocks.createdUser] : [],
    );
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
    for (const [name, value] of [
      ["NODE_ENV", originalNodeEnv],
      ["GOOGLE_CLIENT_ID", originalClientId],
      ["GOOGLE_CLIENT_SECRET", originalClientSecret],
      ["GOOGLE_AUTO_PROVISION_ENABLED", originalAutoProvision],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.unstubAllGlobals();
  });

  async function requestCallback(): Promise<Response> {
    const app = express();
    app.use(cookieParser());
    app.use("/api", router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a disposable TCP listener");
    }
    return fetch(
      `http://127.0.0.1:${address.port}/api/auth/google/callback?code=code&state=state`,
      {
        headers: { Cookie: "healthdocs_oauth_nonce=browser-nonce" },
        redirect: "manual",
      },
    );
  }

  it("refuses to link an existing local account by verified email", async () => {
    oauthMocks.usersByEmail = [{
      ...linkedUser,
      googleId: null,
    }];
    mockGoogleProfile();

    const response = await requestCallback();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://credentials.example.sa/login?error=oauth_failed",
    );
    expect(oauthMocks.insert).not.toHaveBeenCalled();
    expect(oauthMocks.setSessionCookie).not.toHaveBeenCalled();
  });

  it("signs in an account that was explicitly linked by googleId", async () => {
    oauthMocks.usersByGoogleId = [linkedUser];
    mockGoogleProfile();

    const response = await requestCallback();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://credentials.example.sa/",
    );
    expect(oauthMocks.insert).not.toHaveBeenCalled();
    expect(oauthMocks.setSessionCookie).toHaveBeenCalledWith(
      expect.anything(),
      "session-token",
    );
    expect(oauthMocks.logAudit).toHaveBeenCalledWith(
      linkedUser,
      "Signed in (Google)",
      "تسجيل دخول عبر Google",
      "Session",
      "الجلسة",
      undefined,
      expect.anything(),
    );
  });

  it("auto-provisions only a non-production employee when no account exists", async () => {
    oauthMocks.facilities = [{ id: 20 }];
    oauthMocks.createdUser = {
      ...linkedUser,
      id: 9,
      facilityId: 20,
    };
    mockGoogleProfile("new-worker@example.sa");

    const response = await requestCallback();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://credentials.example.sa/",
    );
    expect(oauthMocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "new-worker@example.sa",
        googleId: "google-subject",
        role: "employee",
        facilityId: 20,
        isActive: true,
      }),
    );
  });

  it("fails closed instead of auto-provisioning in production", async () => {
    process.env.NODE_ENV = "production";
    oauthMocks.facilities = [{ id: 20 }];
    mockGoogleProfile("new-worker@example.sa");

    const response = await requestCallback();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://credentials.example.sa/login?error=oauth_failed",
    );
    expect(oauthMocks.insert).not.toHaveBeenCalled();
    expect(oauthMocks.setSessionCookie).not.toHaveBeenCalled();
  });
});
