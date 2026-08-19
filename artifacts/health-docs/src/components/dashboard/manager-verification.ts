export interface SubmissionLock {
  current: boolean;
}

/**
 * Claims one verification submission synchronously. React mutation state is
 * asynchronous, so the ref-backed lock closes the small double-click window.
 */
export function claimVerificationSubmission<T>(
  target: T | null,
  lock: SubmissionLock,
): T | null {
  if (!target || lock.current) return null;
  lock.current = true;
  return target;
}

export function releaseVerificationSubmission(lock: SubmissionLock): void {
  lock.current = false;
}
