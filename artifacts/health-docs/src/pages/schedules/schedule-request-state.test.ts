import { describe, expect, it } from "vitest";
import { ApiError } from "@workspace/api-client-react";
import {
  canReviewScheduleRequest,
  canRevokeApprovedScheduleRequest,
  canWithdrawScheduleRequest,
  requestErrorKey,
  requestReasonTranslationKey,
  scheduleRequestDecisionInput,
  scheduleRequestVersionInput,
  toCreateScheduleRequestInput,
  validateScheduleRequestForm,
  type ScheduleRequestFormValue,
} from "./schedule-request-state";

const valid: ScheduleRequestFormValue = {
  kind: "leave",
  startDate: "2028-02-01",
  endDate: "2028-02-29",
  shiftCode: "",
  note: "Operational note",
};

describe("schedule request state", () => {
  it("accepts a valid leap-month leave range of at most 31 days", () => {
    expect(validateScheduleRequestForm(valid)).toBeNull();
    expect(
      validateScheduleRequestForm({
        ...valid,
        startDate: "2028-01-01",
        endDate: "2028-01-31",
      }),
    ).toBeNull();
  });

  it.each([
    [{ ...valid, startDate: "" }, "required"],
    [{ ...valid, startDate: "2028-02-30" }, "dates"],
    [{ ...valid, startDate: "2028-02-10", endDate: "2028-02-09" }, "dates"],
    [{ ...valid, startDate: "2028-02-01", endDate: "2028-03-01" }, "dates"],
    [{ ...valid, startDate: "1999-02-01" }, "dates"],
  ] as const)("rejects invalid leave dates with %s", (form, issue) => {
    expect(validateScheduleRequestForm(form)).toBe(issue);
  });

  it.each(["off", "eo", "preferred_shift"] as const)(
    "requires %s to use one date",
    (kind) => {
      expect(
        validateScheduleRequestForm({
          ...valid,
          kind,
          startDate: "2028-02-01",
          endDate: "2028-02-02",
          shiftCode: kind === "preferred_shift" ? "M" : "",
        }),
      ).toBe("single_day");
    },
  );

  it("validates and normalizes the preferred shift code contract", () => {
    for (const shiftCode of ["M", "n", " N_2 ", "A-1"])
      expect(
        validateScheduleRequestForm({
          ...valid,
          kind: "preferred_shift",
          endDate: valid.startDate,
          shiftCode,
        }),
      ).toBeNull();
    for (const shiftCode of ["", "1M", "M N", "ABCDEFGHI"])
      expect(
        validateScheduleRequestForm({
          ...valid,
          kind: "preferred_shift",
          endDate: valid.startDate,
          shiftCode,
        }),
      ).toBe("shift");
  });

  it("enforces the optional note length without requiring a note", () => {
    expect(validateScheduleRequestForm({ ...valid, note: "" })).toBeNull();
    expect(validateScheduleRequestForm({ ...valid, note: "x".repeat(500) })).toBeNull();
    expect(validateScheduleRequestForm({ ...valid, note: "x".repeat(501) })).toBe("note");
  });

  it("normalizes the create payload and omits empty or inapplicable fields", () => {
    expect(
      toCreateScheduleRequestInput({
        ...valid,
        kind: "preferred_shift",
        endDate: valid.startDate,
        shiftCode: " n_2 ",
        note: "  Coverage preference  ",
      }),
    ).toEqual({
      kind: "preferred_shift",
      startDate: "2028-02-01",
      endDate: "2028-02-01",
      shiftCode: "N_2",
      note: "Coverage preference",
    });
    expect(
      toCreateScheduleRequestInput({
        ...valid,
        kind: "off",
        shiftCode: "M",
        note: "   ",
      }),
    ).toEqual({
      kind: "off",
      startDate: "2028-02-01",
      endDate: "2028-02-01",
    });
  });

  it("builds CAS payloads from the visible request version", () => {
    expect(scheduleRequestVersionInput(7)).toEqual({ expectedVersion: 7 });
    expect(scheduleRequestDecisionInput(7, "approved")).toEqual({
      expectedVersion: 7,
      decision: "approved",
    });
    expect(scheduleRequestDecisionInput(8, "rejected")).toEqual({
      expectedVersion: 8,
      decision: "rejected",
    });
  });

  it.each([
    [403, "forbidden", "forbidden"],
    [404, "not_found", "forbidden"],
    [409, "version_conflict", "conflict"],
    [400, "invalid", "invalid"],
    [422, "invalid", "invalid"],
    [428, "precondition_required", "invalid"],
    [500, "private server detail", "error"],
  ] as const)("maps API status %s to a safe UI key", (status, code, expected) => {
    const error = new ApiError(
      new Response(null, { status }),
      { code, message: "Private server detail" },
      { method: "POST", url: "/api/schedule-requests" },
    );
    expect(requestErrorKey(error)).toBe(expected);
  });

  it("distinguishes an overlapping approved request from a stale version", () => {
    const error = new ApiError(
      new Response(null, { status: 409 }),
      {
        code: "conflicting_approved_schedule_request",
        message: "private detail",
      },
      { method: "POST", url: "/api/schedule-requests/1/decision" },
    );
    expect(requestErrorKey(error)).toBe("approved_conflict");
  });

  it("maps network errors to the generic message", () => {
    expect(requestErrorKey(new Error("private network detail"))).toBe("error");
  });

  it("translates known feasibility reasons and hides unknown raw codes", () => {
    expect(requestReasonTranslationKey("preferred_shift_available")).toBe(
      "schedules.request_reason_preferred_shift_available",
    );
    expect(requestReasonTranslationKey("published_schedule_requires_reopen")).toBe(
      "schedules.request_reason_published_schedule_requires_reopen",
    );
    expect(requestReasonTranslationKey("private_server_detail_xyz")).toBe(
      "schedules.request_reason_generic",
    );
  });

  it("allows withdrawal only while an own request is pending", () => {
    expect(canWithdrawScheduleRequest("pending")).toBe(true);
    for (const status of ["approved", "rejected", "withdrawn"] as const)
      expect(canWithdrawScheduleRequest(status)).toBe(false);
  });

  it("shows review actions only to a different authenticated manager", () => {
    expect(
      canReviewScheduleRequest({
        status: "pending",
        employeeId: 4,
        reviewerId: 5,
        manager: true,
      }),
    ).toBe(true);
    expect(
      canReviewScheduleRequest({
        status: "pending",
        employeeId: 4,
        reviewerId: 4,
        manager: true,
      }),
    ).toBe(false);
    expect(
      canReviewScheduleRequest({
        status: "pending",
        employeeId: 4,
        reviewerId: 5,
        manager: false,
      }),
    ).toBe(false);
    expect(
      canReviewScheduleRequest({
        status: "approved",
        employeeId: 4,
        reviewerId: 5,
        manager: true,
      }),
    ).toBe(false);
  });

  it("allows only a different manager to revoke an approved request", () => {
    expect(
      canRevokeApprovedScheduleRequest({
        status: "approved",
        employeeId: 4,
        reviewerId: 5,
        manager: true,
      }),
    ).toBe(true);
    expect(
      canRevokeApprovedScheduleRequest({
        status: "pending",
        employeeId: 4,
        reviewerId: 5,
        manager: true,
      }),
    ).toBe(false);
    expect(
      canRevokeApprovedScheduleRequest({
        status: "approved",
        employeeId: 4,
        reviewerId: 4,
        manager: true,
      }),
    ).toBe(false);
  });
});
