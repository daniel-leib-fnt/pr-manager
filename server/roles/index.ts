import type { Db } from '../db.ts';
import type { Pr, RoleName } from '../model.ts';
import { addInstruction, cleanup } from '../prs.ts';
import { own } from './own.ts';
import { review } from './review.ts';
import type { Role } from './role.ts';

/**
 * Every kind of PR the daemon handles. A new one is added here. Each role is written against its own PR
 * type; the cast forgets that, and `roleOf` restores it by handing a PR only to the role it has.
 */
export const roles: Record<RoleName, Role> = { own: own as unknown as Role, review: review as unknown as Role };

/** The role of a PR. This lookup is the only place outside `roles/` where the role decides anything. */
export const roleOf = (pr: Pick<Pr, 'role'>): Role => roles[pr.role];

/** Removes a PR that is over, as far as its role allows. */
export const cleanupPr = (db: Db, pr: Pr) => cleanup(db, pr, roleOf(pr).holdsMyWork);

/** An instruction of mine, plus what it means for the PR's role. */
export function instruct(db: Db, pr: Pr, text: string) {
  addInstruction(db, pr, text);
  roleOf(pr).instructed?.(db, pr);
}
