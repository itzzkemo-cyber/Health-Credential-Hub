import { describe, expect, it } from "vitest";
import {
  generateSchedule,
  scheduleMonthDates,
  SchedulePlanningError,
  validatePlanningInput,
  validateSchedule,
  type SchedulePlanningInput,
} from "./shiftScheduling";

function input(
  overrides: Partial<SchedulePlanningInput> = {},
): SchedulePlanningInput {
  return {
    title: "Unit roster",
    month: "2026-07",
    employeeIds: [1, 2, 3, 4, 5, 6],
    shiftTypes: [
      {
        code: "M",
        label: "Morning",
        labelAr: "صباحي",
        startTime: "07:00",
        endTime: "15:00",
        requiredPerDay: 1,
      },
      {
        code: "A",
        label: "Evening",
        labelAr: "مسائي",
        startTime: "15:00",
        endTime: "23:00",
        requiredPerDay: 1,
      },
      {
        code: "N",
        label: "Night",
        labelAr: "ليلي",
        startTime: "23:00",
        endTime: "07:00",
        requiredPerDay: 1,
      },
    ],
    constraints: {
      minRestHours: 11,
      maxConsecutiveDays: 6,
      maxShiftsPerMonth: 22,
    },
    unavailability: [],
    ...overrides,
  };
}

describe("monthly shift planning", () => {
  it("handles leap years and month lengths without local timezone drift", () => {
    expect(scheduleMonthDates("2028-02")).toHaveLength(29);
    expect(scheduleMonthDates("2026-02")).toHaveLength(28);
    expect(scheduleMonthDates("2026-04")).toHaveLength(30);
    expect(scheduleMonthDates("2026-13")).toEqual([]);
    expect(scheduleMonthDates("2026-7")).toEqual([]);
  });

  it("generates a deterministic complete, valid, balanced proposal without mutating input", () => {
    const config = input();
    const original = structuredClone(config);
    const plan = generateSchedule(config);
    expect(plan).toEqual(
      generateSchedule({
        ...config,
        employeeIds: [...config.employeeIds].reverse(),
      }),
    );
    expect(config).toEqual(original);
    expect(plan.assignments).toHaveLength(31 * 3);
    expect(plan.shortages).toEqual([]);
    expect(validateSchedule(config, plan.assignments).valid).toBe(true);
    const totals = config.employeeIds.map(
      (id) => plan.assignments.filter((item) => item.employeeId === id).length,
    );
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(2);
    expect(
      new Set(plan.assignments.map((item) => `${item.employeeId}:${item.date}`))
        .size,
    ).toBe(plan.assignments.length);
  });

  it("does not assign unavailable employees and reports infeasibility", () => {
    const config = input({
      employeeIds: [1],
      unavailability: [{ employeeId: 1, date: "2026-07-01" }],
    });
    const plan = generateSchedule(config);
    expect(plan.assignments.some((item) => item.date === "2026-07-01")).toBe(
      false,
    );
    expect(
      plan.shortages.filter((item) => item.date === "2026-07-01"),
    ).toHaveLength(3);
    expect(plan.warnings).toContain("coverage_shortage");
    expect(validateSchedule(config, plan.assignments).valid).toBe(true);
    expect(plan.assignments.length).toBeLessThanOrEqual(22);
  });

  it("respects monthly and consecutive limits when coverage cannot be met", () => {
    const config = input({
      employeeIds: [1],
      shiftTypes: [input().shiftTypes[0]!],
      constraints: {
        minRestHours: 11,
        maxConsecutiveDays: 2,
        maxShiftsPerMonth: 5,
      },
    });
    const plan = generateSchedule(config);
    expect(plan.assignments).toHaveLength(5);
    expect(plan.assignments.map((item) => item.date)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-04",
      "2026-07-05",
      "2026-07-07",
    ]);
    expect(plan.shortages).toHaveLength(26);
  });

  it("rejects a morning assignment after an overnight shift with insufficient rest", () => {
    const config = input();
    expect(
      validateSchedule(config, [
        { employeeId: 1, date: "2026-07-01", shiftCode: "N" },
        { employeeId: 1, date: "2026-07-02", shiftCode: "M" },
      ]).issues,
    ).toContain("minimum_rest");
  });

  it("checks both previous and next month rest boundaries", () => {
    const config = input({
      employeeIds: [1],
      shiftTypes: [input().shiftTypes[0]!],
    });
    const previous = [
      {
        employeeId: 1,
        date: "2026-06-30",
        startTime: "23:00",
        endTime: "07:00",
      },
    ];
    expect(
      generateSchedule(config, previous).assignments.some(
        (item) => item.date === "2026-07-01",
      ),
    ).toBe(false);
    expect(
      validateSchedule(
        config,
        [{ employeeId: 1, date: "2026-07-01", shiftCode: "M" }],
        previous,
      ).issues,
    ).toContain("minimum_rest");
    expect(
      validateSchedule(
        input(),
        [{ employeeId: 1, date: "2026-07-31", shiftCode: "N" }],
        [
          {
            employeeId: 1,
            date: "2026-08-01",
            startTime: "07:00",
            endTime: "15:00",
          },
        ],
      ).issues,
    ).toContain("minimum_rest");
  });

  it("checks consecutive days across both month boundaries, independent of client ordering", () => {
    const config = input({
      constraints: {
        minRestHours: 0,
        maxConsecutiveDays: 2,
        maxShiftsPerMonth: 31,
      },
    });
    const context = [
      {
        employeeId: 1,
        date: "2026-06-29",
        startTime: "07:00",
        endTime: "15:00",
      },
      {
        employeeId: 1,
        date: "2026-06-30",
        startTime: "07:00",
        endTime: "15:00",
      },
      {
        employeeId: 2,
        date: "2026-08-01",
        startTime: "07:00",
        endTime: "15:00",
      },
    ];
    expect(
      validateSchedule(
        config,
        [{ employeeId: 1, date: "2026-07-01", shiftCode: "M" }],
        context,
      ).issues,
    ).toContain("consecutive_day_limit");
    expect(
      validateSchedule(
        config,
        [
          { employeeId: 2, date: "2026-07-31", shiftCode: "M" },
          { employeeId: 2, date: "2026-07-30", shiftCode: "M" },
        ],
        context,
      ).issues,
    ).toContain("consecutive_day_limit");
    expect(
      validateSchedule(
        config,
        generateSchedule(config, context).assignments,
        context,
      ).valid,
    ).toBe(true);
  });

  it("cannot weaken stricter neighboring roster rest or consecutive-day rules", () => {
    const config = input({
      constraints: {
        minRestHours: 0,
        maxConsecutiveDays: 31,
        maxShiftsPerMonth: 31,
      },
    });
    const previous = [
      {
        employeeId: 1,
        date: "2026-06-30",
        startTime: "23:00",
        endTime: "07:00",
        minRestHours: 12,
        maxConsecutiveDays: 2,
      },
    ];
    expect(
      validateSchedule(
        config,
        [{ employeeId: 1, date: "2026-07-01", shiftCode: "A" }],
        previous,
      ).issues,
    ).toContain("minimum_rest");
    const next = [
      {
        employeeId: 1,
        date: "2026-08-01",
        startTime: "07:00",
        endTime: "15:00",
        minRestHours: 11,
        maxConsecutiveDays: 2,
      },
    ];
    expect(
      validateSchedule(
        config,
        [
          { employeeId: 1, date: "2026-07-30", shiftCode: "M" },
          { employeeId: 1, date: "2026-07-31", shiftCode: "M" },
        ],
        next,
      ).issues,
    ).toContain("consecutive_day_limit");
    const generated = generateSchedule(config, [...previous, ...next]);
    expect(
      validateSchedule(config, generated.assignments, [...previous, ...next])
        .valid,
    ).toBe(true);
  });

  it("rejects duplicate cells, foreign employees, impossible dates, unknown shifts and unavailable manual edits", () => {
    const config = input({
      unavailability: [{ employeeId: 1, date: "2026-07-02" }],
    });
    const result = validateSchedule(config, [
      { employeeId: 1, date: "2026-07-01", shiftCode: "M" },
      { employeeId: 1, date: "2026-07-01", shiftCode: "N" },
      { employeeId: 1, date: "2026-07-02", shiftCode: "A" },
      { employeeId: 1000, date: "2026-07-04", shiftCode: "M" },
      { employeeId: 2, date: "2026-07-32", shiftCode: "M" },
      { employeeId: 2, date: "2026-06-30", shiftCode: "M" },
      { employeeId: 2, date: "2026-07-01", shiftCode: "O" },
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        "duplicate_employee_day",
        "invalid_assignment",
        "employee_unavailable",
      ]),
    );
  });

  it("allows a safe manual swap and explicit off days without treating shortages as valid coverage", () => {
    const config = input();
    const plan = generateSchedule(config);
    const modified = plan.assignments.filter(
      (item) => item.date !== "2026-07-01",
    );
    const result = validateSchedule(config, modified);
    expect(result.valid).toBe(true);
    expect(result.shortages).toHaveLength(3);
    expect(result.warnings).toContain("coverage_shortage");
  });

  it("permits exact rest boundaries but rejects overlapping shifts even when rest is zero", () => {
    const config = input({
      constraints: {
        minRestHours: 8,
        maxConsecutiveDays: 6,
        maxShiftsPerMonth: 22,
      },
    });
    expect(
      validateSchedule(config, [
        { employeeId: 1, date: "2026-07-01", shiftCode: "A" },
        { employeeId: 1, date: "2026-07-02", shiftCode: "M" },
      ]).valid,
    ).toBe(true);
    const overlapping = input({
      constraints: {
        minRestHours: 0,
        maxConsecutiveDays: 6,
        maxShiftsPerMonth: 22,
      },
      shiftTypes: [
        { ...input().shiftTypes[2]!, endTime: "11:00" },
        input().shiftTypes[0]!,
      ],
    });
    expect(
      validateSchedule(overlapping, [
        { employeeId: 1, date: "2026-07-01", shiftCode: "N" },
        { employeeId: 1, date: "2026-07-02", shiftCode: "M" },
      ]).issues,
    ).toContain("overlapping_shifts");
  });

  it.each([
    ["invalid_month", { month: "2026-02-01" }],
    ["invalid_employees", { employeeIds: [] }],
    ["invalid_employees", { employeeIds: [1, 1] }],
    [
      "invalid_employees",
      { employeeIds: Array.from({ length: 201 }, (_, i) => i + 1) },
    ],
    [
      "invalid_constraints",
      {
        constraints: {
          minRestHours: -1,
          maxConsecutiveDays: 6,
          maxShiftsPerMonth: 22,
        },
      },
    ],
    [
      "invalid_shifts",
      { shiftTypes: [{ ...input().shiftTypes[0]!, endTime: "07:00" }] },
    ],
    [
      "invalid_shifts",
      { shiftTypes: [{ ...input().shiftTypes[0]!, startTime: "24:00" }] },
    ],
    [
      "invalid_shifts",
      {
        shiftTypes: [
          input().shiftTypes[0]!,
          { ...input().shiftTypes[0]!, code: "m" },
        ],
      },
    ],
    [
      "coverage_required",
      { shiftTypes: [{ ...input().shiftTypes[0]!, requiredPerDay: 0 }] },
    ],
    [
      "invalid_unavailability",
      { unavailability: [{ employeeId: 99, date: "2026-07-01" }] },
    ],
    [
      "invalid_unavailability",
      { unavailability: [{ employeeId: 1, date: "2026-02-30" }] },
    ],
  ] as const)(
    "rejects bounded malformed configuration: %s",
    (code, overrides) => {
      const config = input(overrides as Partial<SchedulePlanningInput>);
      expect(validatePlanningInput(config)).toContain(code);
      expect(() => generateSchedule(config)).toThrow(SchedulePlanningError);
      expect(validateSchedule(config, []).valid).toBe(false);
    },
  );

  it("fails closed for malformed adjacent records and never mutates them", () => {
    const adjacent = [
      {
        employeeId: 1,
        date: "2026-06-31",
        startTime: "23:00",
        endTime: "07:00",
      },
    ];
    const original = structuredClone(adjacent);
    expect(() => generateSchedule(input(), adjacent)).toThrow(
      SchedulePlanningError,
    );
    expect(validateSchedule(input(), [], adjacent).valid).toBe(false);
    expect(adjacent).toEqual(original);
  });

  it("handles maximum workforce and shift bounds with explicit unmet demand", () => {
    const config = input({
      month: "2026-08",
      employeeIds: Array.from({ length: 200 }, (_, index) => index + 1),
      shiftTypes: Array.from({ length: 6 }, (_, index) => ({
        code: `S${index}`,
        label: `Shift ${index}`,
        labelAr: `مناوبة ${index}`,
        startTime: `${String(index * 4).padStart(2, "0")}:00`,
        endTime: `${String((index * 4 + 8) % 24).padStart(2, "0")}:00`,
        requiredPerDay: 200,
      })),
    });
    const plan = generateSchedule(config);
    expect(plan.assignments.length).toBeGreaterThan(0);
    expect(plan.assignments.length).toBeLessThanOrEqual(200 * 31);
    expect(plan.shortages.length).toBeGreaterThan(0);
    expect(validateSchedule(config, plan.assignments).valid).toBe(true);
  });

  it("satisfies hard invariants for diverse bounded demand, months and constraints", () => {
    for (let seed = 0; seed < 32; seed++) {
      const config = input({
        month: seed % 2 ? "2028-02" : "2026-09",
        employeeIds: Array.from({ length: (seed % 15) + 1 }, (_, i) => i + 1),
        constraints: {
          minRestHours: seed % 25,
          maxConsecutiveDays: (seed % 7) + 1,
          maxShiftsPerMonth: (seed % 31) + 1,
        },
      });
      config.shiftTypes = config.shiftTypes.map((shift, index) => ({
        ...shift,
        requiredPerDay: (seed + index) % 3,
      }));
      config.unavailability = config.employeeIds.map((employeeId) => ({
        employeeId,
        date: `${config.month}-01`,
      }));
      const plan = generateSchedule(config);
      expect(
        validateSchedule(config, plan.assignments).valid,
        `seed ${seed}`,
      ).toBe(true);
      expect(
        plan.assignments.every((item) => item.date !== `${config.month}-01`),
      ).toBe(true);
    }
  });
});
