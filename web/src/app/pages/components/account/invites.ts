/** Invite helpers of the admin users page (PLAN §6 /api/admin/invites). */
import type { Invite } from '@outpost/shared/api';
import { paths } from '../../../paths.ts';

/** Absolute sign-up link for an invite code. */
export const inviteLink = (code: string, origin: string = window.location.origin): string => `${origin}${paths.signup(code)}`;

/** State of an invite: used, expired or open. */
export function inviteState(i: Invite, now: number = Date.now()): 'used' | 'expired' | 'open' {
  if (i.usedAt !== null || i.usedBy !== null) return 'used';
  if (i.expiresAt !== null && i.expiresAt <= now) return 'expired';
  return 'open';
}
