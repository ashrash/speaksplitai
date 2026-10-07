import type { EntityManager } from 'typeorm';

/** Orders a pair the way the friendships table stores it (user_a < user_b). */
export function pair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export async function areFriends(manager: EntityManager, a: string, b: string): Promise<boolean> {
  const [x, y] = pair(a, b);
  const rows = await manager.query<unknown[]>(
    'select 1 from friendships where user_a = $1 and user_b = $2',
    [x, y],
  );
  return rows.length > 0;
}

/**
 * Records a friendship (no-op if it exists) and marks any pending requests between the two as
 * accepted. Returns true if they weren't friends before.
 */
export async function befriend(
  manager: EntityManager,
  a: string,
  b: string,
  source: 'invite' | 'request',
): Promise<boolean> {
  const [x, y] = pair(a, b);
  const inserted = await manager.query<unknown[]>(
    `insert into friendships (user_a, user_b, source) values ($1, $2, $3)
     on conflict do nothing returning user_a`,
    [x, y, source],
  );
  await manager.query(
    `update friend_requests
     set status = 'accepted', responded_at = now(),
         to_user_id = case when from_user_id = $1 then $2 else $1 end
     where status = 'pending'
       and ((from_user_id = $1 and (to_user_id = $2 or to_email = (select email from users where id = $2)
                                    or to_phone = (select phone from users where id = $2)))
         or (from_user_id = $2 and (to_user_id = $1 or to_email = (select email from users where id = $1)
                                    or to_phone = (select phone from users where id = $1))))`,
    [a, b],
  );
  return inserted.length > 0;
}
