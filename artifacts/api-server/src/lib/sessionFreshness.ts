import type { User } from "@workspace/db";

/**
 * Authentication middleware attaches a database snapshot to the request.
 * Sensitive transactions must re-check that snapshot after locking the actor
 * row so a concurrent deactivation or session revocation cannot race a write.
 */
export function isFreshActiveSessionActor(
  lockedActor: User | undefined,
  requestUser: User,
): lockedActor is User {
  return Boolean(
    lockedActor &&
      lockedActor.id === requestUser.id &&
      lockedActor.isActive &&
      lockedActor.sessionVersion === requestUser.sessionVersion,
  );
}
