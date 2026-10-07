import type { EntityManager } from 'typeorm';

/** True if either user has blocked the other. */
export async function eitherBlocked(
  manager: EntityManager,
  a: string,
  b: string,
): Promise<boolean> {
  const rows = await manager.query<unknown[]>(
    `select 1 from blocks
     where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1)
     limit 1`,
    [a, b],
  );
  return rows.length > 0;
}
