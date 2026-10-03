/** Fail-closed preliminary grant check; production token verification comes separately. */
export interface Grant {
  subject: string;
  deviceId: string;
  capability: string;
  expiresAt: number;
  revoked: boolean;
}
export function permits(
  grant: Grant,
  subject: string,
  deviceId: string,
  capability: string,
  now: number,
): boolean {
  return (
    !grant.revoked &&
    now < grant.expiresAt &&
    grant.subject === subject &&
    grant.deviceId === deviceId &&
    grant.capability === capability
  );
}
