/** Called only by the disposable, opt-in PostgreSQL/HTTP isolation drill. */
import { expect } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import type {
  SchedulePlanningInput,
  ShiftAssignment,
} from "../lib/shiftScheduling";
type Pool = (typeof import("@workspace/db"))["pool"];
type Call = (
  url: string,
  cookie?: string,
  body?: unknown,
  method?: string,
) => Promise<Response>;
interface Roster {
  id: number;
  version: number;
  status: string;
  assignments: ShiftAssignment[];
  issues: string[];
  shortages: unknown[];
}
interface TeamRoster {
  scheduleId: number;
  title: string;
  month: string;
  participants: Array<{ employeeId: number; name: string; nameAr: string }>;
  shiftTypes: Array<Record<string, unknown>>;
  assignments: ShiftAssignment[];
}
interface MyRoster {
  scheduleId: number;
  shiftTypes: Array<Record<string, unknown>>;
  assignments: ShiftAssignment[];
}

export async function runSchedulesPostgresDrill(
  pool: Pool,
  call: Call,
  rootCookie: string,
) {
  const { signToken } = await import("../lib/auth");
  const departments = (
    await pool.query(
      "INSERT INTO departments(name,name_ar,facility_id) VALUES ('Schedule A','A',1),('Schedule other A','AA',1),('Schedule B','B',2) RETURNING id",
    )
  ).rows.map((row) => row.id as number);
  async function user(
    role: string,
    facility: number,
    department: number,
    supervisor: number | null = null,
  ) {
    const n = (await pool.query("SELECT count(*)::int n FROM users")).rows[0].n;
    return (
      await pool.query(
        "INSERT INTO users(email,password_hash,name,name_ar,role,facility_id,department_id,supervisor_id,totp_enabled,totp_secret) SELECT $1,password_hash,$2,$2,$3,$4,$5,$6,true,totp_secret FROM users WHERE id=1 RETURNING id",
        [
          `schedule-${n}@example.invalid`,
          `Fixture ${n}`,
          role,
          facility,
          department,
          supervisor,
        ],
      )
    ).rows[0].id as number;
  }
  const aSupervisor = await user("supervisor", 1, departments[0]);
  const aOtherSupervisor = await user("supervisor", 1, departments[1]);
  const aManager = await user("department_manager", 1, departments[0]);
  const aAdmin = await user("hospital_admin", 1, departments[0]);
  const bSupervisor = await user("supervisor", 2, departments[2]);
  const bManager = await user("department_manager", 2, departments[2]);
  const bAdmin = await user("hospital_admin", 2, departments[2]);
  const a1 = await user("employee", 1, departments[0], aSupervisor);
  const a2 = await user("employee", 1, departments[0], aSupervisor);
  const a3 = await user("employee", 1, departments[1], aOtherSupervisor);
  const b1 = await user("employee", 2, departments[2], bSupervisor);
  const b2 = await user("employee", 2, departments[2], bSupervisor);
  const cookie = (id: number) => `healthdocs_session=${signToken(id, 0)}`;
  const input = (
    month: string,
    employeeIds = [a1, a2],
  ): SchedulePlanningInput => ({
    title: "Synthetic planning fixture",
    month,
    employeeIds,
    shiftTypes: [
      {
        code: "D",
        label: "Day",
        labelAr: "نهار",
        startTime: "08:00",
        endTime: "16:00",
        requiredPerDay: 1,
      },
    ],
    constraints: {
      minRestHours: 8,
      maxConsecutiveDays: 31,
      maxShiftsPerMonth: 31,
    },
    unavailability: [],
  });
  const create = async (
    body: SchedulePlanningInput,
    actor = rootCookie,
  ): Promise<Roster> => {
    const response = await call("/schedules", actor, body);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(
      201,
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    return response.json() as Promise<Roster>;
  };

  expect((await call("/schedules?month=2031-01")).status).toBe(401);
  expect((await call("/schedules", cookie(a1), input("2031-01"))).status).toBe(
    403,
  );
  expect((await call("/schedules?month=2031-01", cookie(a1))).status).toBe(403);
  expect(
    (
      await call("/schedules", rootCookie, {
        ...input("2031-01"),
        constraints: { ...input("2031-01").constraints, minRestHours: 1.5 },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call("/schedules", rootCookie, {
        ...input("2031-01"),
        unavailability: [
          {
            employeeId: a1,
            date: "2031-02-30",
            reason: "must not be accepted",
          },
        ],
      })
    ).status,
  ).toBe(400);
  expect(
    (await call("/schedules", rootCookie, input("2031-01", [a1, a1]))).status,
  ).toBe(400);
  expect(
    (await call("/schedules", rootCookie, input("2031-01", [a1, b1]))).status,
  ).toBe(409);
  await pool.query("UPDATE users SET is_active=false WHERE id=$1", [a2]);
  expect((await call("/schedules", rootCookie, input("2031-01"))).status).toBe(
    409,
  );
  await pool.query("UPDATE users SET is_active=true WHERE id=$1", [a2]);

  // Every manager role may schedule only its current facility/team. A global
  // admin can choose either facility but not combine them in one roster.
  const managers = [
    aSupervisor,
    aManager,
    aAdmin,
    bSupervisor,
    bManager,
    bAdmin,
  ];
  for (const [index, actor] of managers.entries()) {
    const local = index < 3 ? [a1, a2] : [b1, b2];
    const foreign = index < 3 ? [b1, b2] : [a1, a2];
    const month = `2032-${String(index + 1).padStart(2, "0")}`;
    const roster = await create(input(month, local), cookie(actor));
    expect((await call(`/schedules/${roster.id}`, cookie(actor))).status).toBe(
      200,
    );
    expect(
      (
        await call(
          `/schedules/${roster.id}`,
          cookie(index < 3 ? bAdmin : aAdmin),
        )
      ).status,
    ).toBe(404);
    expect(
      (await call("/schedules", cookie(actor), input(month, foreign))).status,
    ).toBe(403);
    expect(
      await (
        await call(
          `/schedules?month=${month}`,
          cookie(index < 3 ? bAdmin : aAdmin),
        )
      ).json(),
    ).toEqual([]);
  }
  expect(
    (await call("/schedules", cookie(aSupervisor), input("2032-09", [a3])))
      .status,
  ).toBe(403);
  expect(
    (await call("/schedules", cookie(aManager), input("2032-09", [a3]))).status,
  ).toBe(403);
  await create(input("2032-09", [aSupervisor]), cookie(aSupervisor)); // Own clinical shifts are allowed.
  await create(input("2032-11", [b1, b2])); // Global administrator facility B.

  const body = input("2033-01");
  body.unavailability = [{ employeeId: a1, date: "2033-01-01" }];
  let roster = await create(body, cookie(aSupervisor));
  expect(roster.shortages).toEqual([]);
  expect((await call(`/schedules/${roster.id}`, cookie(a1))).status).toBe(403);
  expect(
    await (await call("/schedules/mine?month=2033-01", cookie(a1))).json(),
  ).toEqual([]);
  expect(
    await (await call("/schedules/team?month=2033-01", cookie(a1))).json(),
  ).toEqual([]);
  expect(
    (
      await call(
        `/schedules/${roster.id}`,
        cookie(aSupervisor),
        { assignments: [] },
        "PATCH",
      )
    ).status,
  ).toBe(428);
  expect(
    (
      await call(
        `/schedules/${roster.id}`,
        cookie(aSupervisor),
        { expectedVersion: 99, assignments: [] },
        "PATCH",
      )
    ).status,
  ).toBe(409);
  const reviewableDraftResponse = await call(
    `/schedules/${roster.id}`,
    cookie(aSupervisor),
    {
      expectedVersion: 1,
      assignments: [{ employeeId: a1, date: "2033-01-01", shiftCode: "D" }],
    },
    "PATCH",
  );
  expect(reviewableDraftResponse.status).toBe(200);
  const reviewableDraft = (await reviewableDraftResponse.json()) as Roster;
  expect(reviewableDraft.version).toBe(2);
  expect(reviewableDraft.issues).toContain("employee_unavailable");
  expect(
    (
      await call(
        `/schedules/${roster.id}/publish`,
        cookie(aSupervisor),
        { expectedVersion: reviewableDraft.version },
      )
    ).status,
  ).toBe(409);
  const correctedResponse = await call(
    `/schedules/${roster.id}`,
    cookie(aSupervisor),
    { expectedVersion: reviewableDraft.version, assignments: roster.assignments },
    "PATCH",
  );
  expect(correctedResponse.status).toBe(200);
  roster = (await correctedResponse.json()) as Roster;
  expect(roster.version).toBe(3);
  expect(roster.issues).toEqual([]);
  expect(
    (
      await call(
        `/schedules/${roster.id}`,
        cookie(aSupervisor),
        {
          expectedVersion: roster.version,
          assignments: [roster.assignments[0], roster.assignments[0]],
        },
        "PATCH",
      )
    ).status,
  ).toBe(400);
  expect((await call("/schedules", rootCookie, body)).status).toBe(409);

  const races = await Promise.all(
    [1, 2].map(() =>
      call(
        `/schedules/${roster.id}`,
        cookie(aSupervisor),
        { expectedVersion: roster.version, assignments: roster.assignments },
        "PATCH",
      ),
    ),
  );
  expect(races.map((response) => response.status).sort()).toEqual([200, 409]);
  roster = (await races
    .find((response) => response.status === 200)!
    .json()) as Roster;
  const published = await call(
    `/schedules/${roster.id}/publish`,
    cookie(aSupervisor),
    { expectedVersion: roster.version },
  );
  expect(published.status).toBe(200);
  roster = (await published.json()) as Roster;
  const mine = (await (
    await call("/schedules/mine?month=2033-01", cookie(a1))
  ).json()) as MyRoster[];
  expect(mine).toHaveLength(1);
  expect(mine[0].scheduleId).toBe(roster.id);
  expect(mine[0].assignments.length).toBeGreaterThan(0);
  expect(mine[0].assignments.every((item) => item.employeeId === a1)).toBe(
    true,
  );
  expect(mine[0]).not.toHaveProperty("participants");
  expect(mine[0].shiftTypes[0]).not.toHaveProperty("requiredPerDay");
  const team = (await (
    await call("/schedules/team?month=2033-01", cookie(a1))
  ).json()) as TeamRoster[];
  expect(team).toHaveLength(1);
  expect(team[0].scheduleId).toBe(roster.id);
  expect(team[0].participants.map((item) => item.employeeId)).toEqual([a1, a2]);
  expect(new Set(team[0].assignments.map((item) => item.employeeId))).toEqual(
    new Set([a1, a2]),
  );
  expect(team[0].participants[0]).toEqual({
    employeeId: a1,
    name: expect.any(String),
    nameAr: expect.any(String),
  });
  expect(team[0]).not.toHaveProperty("unavailability");
  expect(team[0]).not.toHaveProperty("employeeIds");
  expect(team[0]).not.toHaveProperty("constraints");
  expect(team[0]).not.toHaveProperty("status");
  expect(team[0].participants[0]).not.toHaveProperty("email");
  expect(team[0].shiftTypes[0]).not.toHaveProperty("requiredPerDay");
  expect(
    await (await call("/schedules/mine?month=2033-01", cookie(b1))).json(),
  ).toEqual([]);
  expect(
    await (await call("/schedules/team?month=2033-01", cookie(b1))).json(),
  ).toEqual([]);
  expect(
    await (await call("/schedules/mine?month=2033-01", cookie(a3))).json(),
  ).toEqual([]);
  expect(
    await (await call("/schedules/team?month=2033-01", cookie(a3))).json(),
  ).toEqual([]);
  await pool.query("UPDATE users SET is_active=false WHERE id=$1", [a2]);
  expect(
    await (await call("/schedules/team?month=2033-01", cookie(a1))).json(),
  ).toEqual([]);
  await pool.query("UPDATE users SET is_active=true WHERE id=$1", [a2]);
  expect(
    (
      await call(
        `/schedules/${roster.id}`,
        cookie(aSupervisor),
        { expectedVersion: roster.version, assignments: [] },
        "PATCH",
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await call(`/schedules/${roster.id}/cancel`, cookie(aSupervisor), {
        expectedVersion: roster.version,
      })
    ).status,
  ).toBe(409);

  // A single transferred participant hides the WHOLE roster, not just that row.
  await pool.query(
    "UPDATE users SET supervisor_id=NULL,department_id=NULL WHERE id=$1",
    [a2],
  );
  expect(
    (await call(`/schedules/${roster.id}`, cookie(aSupervisor))).status,
  ).toBe(404);
  expect((await call(`/schedules/${roster.id}`, cookie(aManager))).status).toBe(
    404,
  );
  await pool.query(
    "UPDATE users SET supervisor_id=$1,department_id=$2 WHERE id=$3",
    [aOtherSupervisor, departments[1], a2],
  );
  expect(
    (await call(`/schedules/${roster.id}`, cookie(aSupervisor))).status,
  ).toBe(404);
  expect((await call(`/schedules/${roster.id}`, cookie(aManager))).status).toBe(
    404,
  );
  expect(
    await (await call("/schedules?month=2033-01", cookie(aSupervisor))).json(),
  ).toEqual([]);
  // Published roster membership itself defines the employee's team. A
  // same-facility department/supervisor reassignment does not expose other
  // workforce data and does not fragment the published team roster.
  const reassignedTeam = (await (
    await call("/schedules/team?month=2033-01", cookie(a1))
  ).json()) as TeamRoster[];
  expect(reassignedTeam).toHaveLength(1);
  expect(reassignedTeam[0].participants.map((item) => item.employeeId)).toEqual(
    [a1, a2],
  );
  expect(
    (
      await call(`/schedules/${roster.id}/reopen`, cookie(aSupervisor), {
        expectedVersion: roster.version,
      })
    ).status,
  ).toBe(404);
  await pool.query("UPDATE users SET facility_id=2 WHERE id=$1", [a2]);
  expect((await call(`/schedules/${roster.id}`, cookie(aAdmin))).status).toBe(
    404,
  );
  expect((await call(`/schedules/${roster.id}`, rootCookie)).status).toBe(200);
  expect(
    await (await call("/schedules/team?month=2033-01", cookie(a1))).json(),
  ).toEqual([]);
  expect(
    await (await call("/schedules/team?month=2033-01", cookie(a2))).json(),
  ).toEqual([]);
  await pool.query(
    "UPDATE users SET supervisor_id=$1,department_id=$2,facility_id=1 WHERE id=$3",
    [aSupervisor, departments[0], a2],
  );
  const reopened = await call(
    `/schedules/${roster.id}/reopen`,
    cookie(aSupervisor),
    { expectedVersion: roster.version },
  );
  expect(reopened.status).toBe(200);
  roster = (await reopened.json()) as Roster;
  expect(
    await (await call("/schedules/mine?month=2033-01", cookie(a1))).json(),
  ).toEqual([]);
  expect(
    await (await call("/schedules/team?month=2033-01", cookie(a1))).json(),
  ).toEqual([]);
  const cancelled = await call(
    `/schedules/${roster.id}/cancel`,
    cookie(aSupervisor),
    { expectedVersion: roster.version },
  );
  expect(cancelled.status).toBe(200);
  expect(((await cancelled.json()) as { status: string }).status).toBe(
    "cancelled",
  );
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM shift_schedule_members WHERE schedule_id=$1 AND released_at IS NOT NULL",
        [roster.id],
      )
    ).rows[0].n,
  ).toBe(2);
  expect(
    (await call(`/schedules/${roster.id}`, cookie(aSupervisor))).status,
  ).toBe(200);
  expect(
    await (await call("/schedules?month=2033-01", cookie(aSupervisor))).json(),
  ).toEqual([]);
  const corrected = await create(body, cookie(aSupervisor));

  const shortage = await create({
    ...input("2034-01", [a3]),
    constraints: {
      minRestHours: 8,
      maxConsecutiveDays: 1,
      maxShiftsPerMonth: 1,
    },
  });
  expect(shortage.shortages.length).toBeGreaterThan(0);
  expect(
    (
      await call(`/schedules/${shortage.id}/publish`, rootCookie, {
        expectedVersion: shortage.version,
      })
    ).status,
  ).toBe(409);

  // Two months cannot simultaneously win an overnight-rest conflict even if
  // the new month has a weaker configured rest limit than its neighbor.
  const night = {
    code: "N",
    label: "Night",
    labelAr: "ليل",
    startTime: "22:00",
    endTime: "06:00",
    requiredPerDay: 1,
  };
  let prior = await create({
    ...input("2035-09", [a3]),
    shiftTypes: [night],
    constraints: {
      minRestHours: 12,
      maxConsecutiveDays: 31,
      maxShiftsPerMonth: 31,
    },
  });
  let next = await create({
    ...input("2035-10", [a3]),
    constraints: {
      minRestHours: 0,
      maxConsecutiveDays: 31,
      maxShiftsPerMonth: 31,
    },
  });
  prior = (await (
    await call(
      `/schedules/${prior.id}`,
      rootCookie,
      { expectedVersion: prior.version, assignments: [] },
      "PATCH",
    )
  ).json()) as Roster;
  next = (await (
    await call(
      `/schedules/${next.id}`,
      rootCookie,
      { expectedVersion: next.version, assignments: [] },
      "PATCH",
    )
  ).json()) as Roster;
  const boundaryRaces = await Promise.all([
    call(
      `/schedules/${prior.id}`,
      rootCookie,
      {
        expectedVersion: prior.version,
        assignments: [{ employeeId: a3, date: "2035-09-30", shiftCode: "N" }],
      },
      "PATCH",
    ),
    call(
      `/schedules/${next.id}`,
      rootCookie,
      {
        expectedVersion: next.version,
        assignments: [{ employeeId: a3, date: "2035-10-01", shiftCode: "D" }],
      },
      "PATCH",
    ),
  ]);
  expect(boundaryRaces.map((response) => response.status).sort()).toEqual([
    200, 400,
  ]);

  // Audit persistence and roster/membership changes share one transaction.
  await pool.query(
    "CREATE FUNCTION reject_schedule_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='Created shift schedule' THEN RAISE EXCEPTION 'fixture audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_schedule_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_schedule_audit()",
  );
  expect((await call("/schedules", rootCookie, input("2037-01"))).status).toBe(
    500,
  );
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM shift_schedules WHERE month='2037-01'",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM shift_schedule_members WHERE month='2037-01'",
      )
    ).rows[0].n,
  ).toBe(0);
  await pool.query(
    "DROP TRIGGER reject_schedule_audit ON audit_logs; DROP FUNCTION reject_schedule_audit()",
  );
  const audits = (
    await pool.query(
      "SELECT details,facility_id FROM audit_logs WHERE action LIKE '%shift schedule'",
    )
  ).rows;
  expect(audits.length).toBeGreaterThan(10);
  for (const audit of audits) {
    expect([1, 2]).toContain(audit.facility_id);
    const details = JSON.parse(audit.details);
    expect(Object.keys(details).sort()).toEqual([
      "employeeCount",
      "month",
      "scheduleId",
      "status",
      "version",
    ]);
  }

  // Pause after the middleware snapshot but before participant locks; changes
  // committed while the request waits must be rechecked inside the transaction.
  async function raceScopeChange(
    update: string,
    parameters: number[],
    status: number,
  ) {
    const connection = await pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await connection.query("BEGIN");
      await connection.query(update, parameters);
      pending = call(
        `/schedules/${corrected.id}`,
        cookie(aSupervisor),
        {
          expectedVersion: corrected.version,
          assignments: corrected.assignments,
        },
        "PATCH",
      );
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const waiting = await pool.query(
          "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%users%'",
        );
        if (waiting.rows[0].n > 0) {
          blocked = true;
          break;
        }
        await delay(20);
      }
      expect(blocked).toBe(true);
      await connection.query("COMMIT");
      expect((await pending).status).toBe(status);
      expect(
        (
          await pool.query(
            "SELECT row_version FROM shift_schedules WHERE id=$1",
            [corrected.id],
          )
        ).rows[0].row_version,
      ).toBe(corrected.version);
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
      await pending;
    }
  }
  await raceScopeChange(
    "UPDATE users SET supervisor_id=$1 WHERE id=$2",
    [aOtherSupervisor, a2],
    403,
  );
  await pool.query("UPDATE users SET supervisor_id=$1 WHERE id=$2", [
    aSupervisor,
    a2,
  ]);
  await raceScopeChange(
    "UPDATE users SET is_active=false WHERE id=$1",
    [a2],
    409,
  );
  await pool.query("UPDATE users SET is_active=true WHERE id=$1", [a2]);
  await raceScopeChange(
    "UPDATE users SET role='employee' WHERE id=$1",
    [aSupervisor],
    403,
  );
  await pool.query("UPDATE users SET role='supervisor' WHERE id=$1", [
    aSupervisor,
  ]);
  await raceScopeChange(
    "UPDATE users SET session_version=session_version+1 WHERE id=$1",
    [aSupervisor],
    401,
  );
}
