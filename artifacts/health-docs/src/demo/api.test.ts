import {
  demoLogin,
  listCredentials,
  listEmployees,
  setRequestHandler,
  updateCredential,
} from "@workspace/api-client-react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createShowcaseRequestHandler,
  enableShowcaseApi,
  resetShowcaseApiState,
} from "./api";

describe("showcase API", () => {
  beforeEach(() => resetShowcaseApiState());
  afterEach(() => setRequestHandler(null));

  it("integrates with the generated API client without network access", async () => {
    enableShowcaseApi();
    const session = await demoLogin({ role: "employee" });
    const list = await listCredentials();

    expect(session.user.role).toBe("employee");
    expect(list.total).toBe(3);
  });

  it("signs into the synthetic employee account", async () => {
    const response = await request("/api/auth/demo-login", "POST", {
      role: "employee",
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.user).toMatchObject({
      email: "employee@healthdocs.sa",
      role: "employee",
    });
  });

  it("gives a one-click manager scoped staff and a reviewable queue", async () => {
    enableShowcaseApi();
    const session = await demoLogin({ role: "hospital_admin" });
    const employees = await listEmployees({ isActive: true });
    const list = await listCredentials({ isVerified: false, pageSize: 1 });
    const pending = list.data[0];

    expect(session.user.role).toBe("hospital_admin");
    expect(employees.length).toBeGreaterThan(1);
    expect(list.total).toBeGreaterThan(1);
    expect(list.data).toHaveLength(1);
    expect(pending?.isVerified).toBe(false);
    expect(pending?.employee).toBeDefined();

    const verified = await updateCredential(pending!.id, {
      expectedVersion: pending!.version,
      isVerified: true,
    });
    expect(verified.isVerified).toBe(true);
    expect(verified.version).toBe(pending!.version + 1);
  });

  it("does not expose management staff to the employee showcase", async () => {
    enableShowcaseApi();
    await demoLogin({ role: "employee" });

    expect(await listEmployees({ isActive: true })).toEqual([]);
    expect((await listCredentials({ pageSize: 100 })).total).toBe(3);
  });

  it("returns a consistent employee dashboard and credential list", async () => {
    const dashboard = await (await request("/api/dashboard/stats")).json();
    const credentials = await (await request("/api/credentials")).json();

    expect(credentials.total).toBe(3);
    expect(dashboard.totalCredentials).toBe(credentials.total);
    expect(dashboard.expiredCredentials).toBe(1);
    expect(dashboard.expiringCredentials).toBe(1);
  });

  it("creates and deletes an in-memory credential", async () => {
    const createResponse = await request("/api/credentials", "POST", {
      employeeId: 999,
      type: "BLS",
      holderName: "Noura Alqahtani",
      holderNameAr: "نورة القحطاني",
      issuerName: "Saudi Heart Association",
      issuerNameAr: "جمعية القلب السعودية",
      certificateNumber: "SHOWCASE-NEW-1",
      issueDate: "2026-01-01",
      expiryDate: "2030-01-01",
      fileUrl: "/objects/showcase/test",
      fileType: "image",
    });
    const created = await createResponse.json();

    expect(createResponse.status).toBe(201);
    expect(created.employeeId).toBe(5);
    expect(created.isVerified).toBe(false);

    const afterCreate = await (await request("/api/credentials")).json();
    expect(afterCreate.total).toBe(4);

    const deleteResponse = await request(
      `/api/credentials/${created.id}`,
      "DELETE",
    );
    expect(deleteResponse.status).toBe(204);
    const afterDelete = await (await request("/api/credentials")).json();
    expect(afterDelete.total).toBe(3);
  });

  it("restores synthetic credentials after the local showcase resets", async () => {
    const initial = await (await request("/api/credentials")).json();
    const credentialId = initial.data[0].id;

    const deleteResponse = await request(
      `/api/credentials/${credentialId}`,
      "DELETE",
    );
    expect(deleteResponse.status).toBe(204);
    expect((await (await request("/api/credentials")).json()).total).toBe(2);

    resetShowcaseApiState();

    const restored = await (await request("/api/credentials")).json();
    expect(restored.total).toBe(3);
    expect(
      restored.data.some((item: { id: number }) => item.id === credentialId),
    ).toBe(true);
  });

  it("simulates OCR without contacting an external provider", async () => {
    const response = await request("/api/credentials/ocr", "POST", {
      fileUrl: "/objects/showcase/test",
      fileName: "certificate.jpg",
    });
    const payload = await response.json();

    expect(payload).toMatchObject({
      detectedType: "BLS",
      holderNameAr: "نورة القحطاني",
    });
    expect(payload.confidence.overall).toBeGreaterThan(0.9);
  });

  it("rejects missing or reversed dates", async () => {
    const response = await request("/api/credentials", "POST", {
      employeeId: 5,
      type: "BLS",
      holderName: "Noura Alqahtani",
      holderNameAr: "نورة القحطاني",
      issuerName: "Saudi Heart Association",
      issuerNameAr: "جمعية القلب السعودية",
      certificateNumber: "INVALID-DATE",
      issueDate: "",
      expiryDate: "2026-01-01",
    });

    expect(response.status).toBe(400);
  });

  it("blocks unknown application API calls instead of reaching a real service", async () => {
    const response = await request("/api/integrations", "GET");
    expect(response.status).toBe(404);

    const handler = createShowcaseRequestHandler();
    await expect(
      handler("https://example.com/image.png", {}),
    ).resolves.toBeUndefined();
  });
});

async function request(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Response> {
  const handler = createShowcaseRequestHandler();
  const response = await handler(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response)
    throw new Error(`Showcase handler did not handle ${method} ${path}`);
  return response;
}
