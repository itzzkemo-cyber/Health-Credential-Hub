import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { safeErrorLogFields } from "./lib/safeError";
import { safeRequestPath } from "./lib/safeRequestPath";
import { allowedOrigins, csrfOriginGuard } from "./lib/csrf";
import { validateTotpEncryptionConfig } from "./lib/totpSecret";
import {
  getStorageConnectSources,
  validateObjectStorageConfiguration,
} from "./lib/objectStorage";
import { isSpaDocumentRequest } from "./lib/spaFallback";

const app: Express = express();
const isProduction = process.env.NODE_ENV === "production";

const storageConnectSources = getStorageConnectSources();

validateTotpEncryptionConfig();
validateObjectStorageConfiguration();
app.disable("x-powered-by");

// Behind Cloud Run's managed proxy: trust the first hop so req.ip (audit logs)
// and req.secure reflect the real client instead of the proxy.
app.set("trust proxy", 1);

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: isProduction
      ? {
          directives: {
            defaultSrc: ["'self'"],
            baseUri: ["'self'"],
            connectSrc: ["'self'", ...storageConnectSources],
            fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
            imgSrc: ["'self'", "data:", "blob:", "https:"],
            objectSrc: ["'self'", "blob:"],
            scriptSrc: ["'self'"],
            styleSrc: [
              "'self'",
              "'unsafe-inline'",
              "https://fonts.googleapis.com",
            ],
            upgradeInsecureRequests: [],
          },
        }
      : false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    xFrameOptions: { action: "deny" },
  }),
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: safeRequestPath(req.url),
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
      callback(
        null,
        origin != null && allowedOrigins.has(origin) ? origin : false,
      );
    },
    credentials: true,
  }),
);
app.use(cookieParser());
// Files upload directly to private object storage. Keep the shared JSON parser
// small so ordinary API routes cannot be used for oversized request bodies.
app.use(express.json({ limit: "1mb" }));

// csrfOriginGuard (lib/csrf.ts) protects cookie-authenticated mutations;
// the session-issuing login routes carry their own guard route-side.
// API responses can contain workforce and credential data. Prevent browsers,
// intermediary proxies, and Cloudflare from retaining any API response unless
// an individual route deliberately overrides this with an even stricter
// private policy (for example credential document downloads).
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  next();
});
app.use("/api", csrfOriginGuard, router);

// Never let unknown API paths fall through to the SPA's HTML entry point.
app.use("/api", (_req, res) => {
  res.status(404).json({ message: "API endpoint not found" });
});

// A published deployment is intentionally one same-origin service: Express
// serves the built React application and the API from the same HTTPS domain.
// This removes cross-site cookies from the production architecture.
if (isProduction || process.env.SERVE_WEB === "true") {
  const candidates = process.env.WEB_DIST_DIR
    ? [path.resolve(process.cwd(), process.env.WEB_DIST_DIR)]
    : [
        path.resolve(process.cwd(), "artifacts/health-docs/dist/public"),
        path.resolve(process.cwd(), "../health-docs/dist/public"),
      ];
  const webDist = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "index.html")),
  );
  if (!webDist) {
    throw new Error(
      `Built web application not found (checked: ${candidates.join(", ")})`,
    );
  }
  app.use(
    express.static(webDist, {
      index: false,
      setHeaders(res, filePath) {
        res.setHeader(
          "Cache-Control",
          filePath.endsWith("index.html")
            ? "no-cache"
            : "public, max-age=31536000, immutable",
        );
      },
    }),
  );
  app.use((req, res, next) => {
    if (!isSpaDocumentRequest(req.method, Boolean(req.accepts("html")))) {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(webDist, "index.html"));
  });
}

// JSON error responses instead of Express's default HTML error page, so the
// web clients can show a localized message. Body-parser rejects
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
      message: "Request body too large — the maximum size is 1 MB",
      messageAr: "حجم جسم الطلب كبير جداً — الحد الأقصى 1 ميغابايت",
    });
    return;
  }
  req.log.error(safeErrorLogFields(err), "Unhandled error");
  res
    .status(
      typeof status === "number" && status >= 400 && status < 600
        ? status
        : 500,
    )
    .json({ message: "Internal server error" });
});

export default app;
