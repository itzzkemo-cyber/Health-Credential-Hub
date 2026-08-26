export type CredentialOwnerState = "ready" | "loading" | "error";

export function getCredentialOwnerState({
  employeeId,
  currentUserId,
  isLoading,
  isError,
  hasTargetEmployee,
}: {
  employeeId?: number;
  currentUserId?: number;
  isLoading: boolean;
  isError: boolean;
  hasTargetEmployee: boolean;
}): CredentialOwnerState {
  if (!employeeId) return "error";
  if (employeeId === currentUserId) return "ready";
  if (isLoading) return "loading";
  if (isError || !hasTargetEmployee) return "error";
  return "ready";
}
