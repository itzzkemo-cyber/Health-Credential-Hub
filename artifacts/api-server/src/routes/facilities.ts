import { Router, type IRouter } from "express";
import { db, facilitiesTable } from "@workspace/db";

const router: IRouter = Router();

// Public on purpose: the self-registration form needs the facility dropdown
// before any session exists. Only id + display names are exposed.
router.get("/facilities", async (_req, res) => {
  const rows = await db
    .select({
      id: facilitiesTable.id,
      name: facilitiesTable.name,
      nameAr: facilitiesTable.nameAr,
    })
    .from(facilitiesTable)
    .orderBy(facilitiesTable.name);
  res.json(rows);
});

export default router;
