import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { allowedOrigins, csrfOriginGuard } from "./lib/csrf";

const app: Express = express();

// Behind the Replit proxy: trust the first hop so req.ip (audit logs) and
// req.secure reflect the real client instead of the proxy.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// CORS: only first-party origins (allowlist in lib/csrf.ts) may make
// cross-origin browser requests; every other origin gets no
// Access-Control-Allow-Origin header, so browsers block cross-origin reads.
// Requests without an Origin header (curl, native mobile apps) are unaffected
// — CORS is a browser read-permission mechanism, not authentication.
app.use(
  cors({
    origin(origin, callback) {
      // `origin` is undefined for same-origin and non-browser requests.
      callback(null, origin != null && allowedOrigins.has(origin) ? origin : false);
    },
    credentials: true,
  }),
);
app.use(cookieParser());
// The web client downscales images before upload and caps payloads at ~15 MB
// of file content (≈20 MB once base64-encoded); 25 MB here leaves headroom so
// legitimate uploads never race the limit.
app.use(express.json({ limit: "25mb" }));

// csrfOriginGuard (lib/csrf.ts) protects cookie-authenticated mutations;
// the session-issuing login routes carry their own guard route-side.
app.use("/api", csrfOriginGuard, router);

// JSON error responses instead of Express's default HTML error page, so the
// web/mobile clients can show a localized message. Body-parser rejects
// oversized payloads before any route runs (413); anything else is an
// unexpected server error.
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = (err as { status?: number } | null)?.status;
  if (status === 413) {
    res.status(413).json({
      message: "File too large — the maximum upload size is 15 MB",
      messageAr: "الملف كبير جداً — الحد الأقصى للرفع 15 ميغابايت",
    });
    return;
  }
  req.log.error({ err }, "Unhandled error");
  res
    .status(typeof status === "number" && status >= 400 && status < 600 ? status : 500)
    .json({ message: "Internal server error" });
});

export default app;
