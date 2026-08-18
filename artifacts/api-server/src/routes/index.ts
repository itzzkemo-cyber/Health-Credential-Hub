import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import oauthRouter from "./oauth";
import dashboardRouter from "./dashboard";
import credentialsRouter from "./credentials";
import employeesRouter from "./employees";
import departmentsRouter from "./departments";
import facilitiesRouter from "./facilities";
import notificationsRouter from "./notifications";
import auditLogsRouter from "./audit-logs";
import policiesRouter from "./policies";
import reportsRouter from "./reports";
import storageRouter from "./storage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(oauthRouter);
router.use(dashboardRouter);
router.use(credentialsRouter);
router.use(employeesRouter);
router.use(departmentsRouter);
router.use(facilitiesRouter);
router.use(notificationsRouter);
router.use(auditLogsRouter);
router.use(policiesRouter);
router.use(reportsRouter);
router.use(storageRouter);

export default router;
