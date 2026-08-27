import type { ListDepartmentsParams } from "@workspace/api-client-react";

/**
 * Only system administrators select another facility. Other roles deliberately
 * omit the selector so their server-enforced facility scope remains explicit.
 */
export function getDepartmentQueryParams(
  actorRole: string | undefined,
  facilityId: number | null | undefined,
): ListDepartmentsParams | undefined {
  return actorRole === "system_admin" && facilityId != null
    ? { facilityId }
    : undefined;
}
