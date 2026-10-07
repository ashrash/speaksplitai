import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Friends: explicit friendships, friend requests (by user, email or phone) and friend invite
 * links. Invites gain a `kind`; friend invites have no group.
 */
export class Friends1791400000000 implements MigrationInterface {
  name = 'Friends1791400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(UP_SQL);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(DOWN_SQL);
  }
}

const UP_SQL = String.raw`
-- invites: 'group' (join a group) or 'friend' (become friends with the creator, no group)
alter table invites add column kind text not null default 'group';
alter table invites alter column group_id drop not null;
alter table invites
  add constraint invites_kind_ck             check (kind in ('group','friend')),
  add constraint invites_kind_group_ck       check ((kind = 'group') = (group_id is not null)),
  add constraint invites_friend_no_target_ck check (kind = 'group' or placeholder_member_id is null);
create index invites_friend_creator_idx on invites (created_by) where kind = 'friend' and revoked_at is null;

-- friendships: one row per pair, user_a < user_b
create table friendships (
  user_a      uuid        not null references users (id) on delete cascade,
  user_b      uuid        not null references users (id) on delete cascade,
  source      text        not null,
  created_at  timestamptz not null default now(),

  constraint friendships_pk        primary key (user_a, user_b),
  constraint friendships_order_ck  check (user_a < user_b),
  constraint friendships_source_ck check (source in ('invite','request'))
);
create index friendships_user_b_idx on friendships (user_b);

-- friend_requests: to a known user, or to an email / phone that may match someone later
create table friend_requests (
  id            uuid        primary key default gen_random_uuid(),
  from_user_id  uuid        not null references users (id) on delete cascade,
  to_user_id    uuid        references users (id) on delete cascade,
  to_email      citext,
  to_phone      text,
  status        text        not null default 'pending',
  created_at    timestamptz not null default now(),
  responded_at  timestamptz,

  constraint friend_requests_target_ck   check (num_nonnulls(to_user_id, to_email, to_phone) >= 1),
  constraint friend_requests_not_self_ck check (to_user_id is null or to_user_id <> from_user_id),
  constraint friend_requests_status_ck   check (status in ('pending','accepted','declined','cancelled')),
  constraint friend_requests_resp_ck     check ((status = 'pending') = (responded_at is null)),
  constraint friend_requests_email_ck    check (to_email is null or to_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  constraint friend_requests_phone_ck    check (to_phone is null or to_phone ~ '^\+[1-9][0-9]{7,14}$')
);
create unique index friend_requests_pending_user_uq  on friend_requests (from_user_id, to_user_id) where status = 'pending' and to_user_id is not null;
create unique index friend_requests_pending_email_uq on friend_requests (from_user_id, to_email)   where status = 'pending' and to_email is not null;
create unique index friend_requests_pending_phone_uq on friend_requests (from_user_id, to_phone)   where status = 'pending' and to_phone is not null;
create index friend_requests_to_user_idx  on friend_requests (to_user_id) where status = 'pending';
create index friend_requests_to_email_idx on friend_requests (to_email)   where status = 'pending';
create index friend_requests_to_phone_idx on friend_requests (to_phone)   where status = 'pending';
create index friend_requests_from_recent_idx on friend_requests (from_user_id, created_at desc);
`;

const DOWN_SQL = String.raw`
drop table if exists friend_requests;
drop table if exists friendships;
delete from invites where kind = 'friend';
drop index if exists invites_friend_creator_idx;
alter table invites
  drop constraint if exists invites_friend_no_target_ck,
  drop constraint if exists invites_kind_group_ck,
  drop constraint if exists invites_kind_ck;
alter table invites alter column group_id set not null;
alter table invites drop column if exists kind;
`;
