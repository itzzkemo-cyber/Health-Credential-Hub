import { Router, type IRouter } from "express";
import { db, facilitiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getUser, requireAuth } from "../lib/auth";

const router: IRouter = Router();

router.use("/facilities", requireAuth);

router.get("/facilities", async (req, res) => {
  const user = getUser(req);
  const query = db
    .select({
      id: facilitiesTable.id,
      name: facilitiesTable.name,
      nameAr: facilitiesTable.nameAr,
    })
    .from(facilitiesTable);
  // Only system administrators have a global facility directory. Every other
  // role receives exactly its own facility, with the boundary enforced in SQL.
  const rows =
    user.role === "system_admin"
      ? await query.orderBy(facilitiesTable.name)
      : await query
          .where(eq(facilitiesTable.id, user.facilityId))
          .orderBy(facilitiesTable.name);
  res.json(rows);
});

export default router;
