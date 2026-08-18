/**
 * App-wide data types.
 *
 * These re-export the types generated from the shared OpenAPI spec so the
 * mobile app always matches the real server contract (numeric IDs, server
 * role/status enums, bilingual fields).
 */
import type { CredentialType } from '@workspace/api-client-react';

export type {
  User,
  UserRole,
  Credential,
  CredentialType,
  CredentialStatus,
  CredentialInput,
  EmployeeSummary,
  Employee,
  EmployeeWithStats,
  EmployeeDetail,
  Department,
  DepartmentWithStats,
  Notification,
  DashboardStats,
  AuditLog,
  OcrResult,
} from '@workspace/api-client-react';

/** Alias kept for existing UI code (credential type registry keys). */
export type CredentialTypeKey = CredentialType;
