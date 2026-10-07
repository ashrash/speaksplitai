import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type {
  Friend,
  FriendRequestInput,
  FriendRequestResult,
  FriendRequestsResponse,
  FriendRequestView,
} from '@speaksplit/api-types';
import { DataSource, type EntityManager } from 'typeorm';
import { eitherBlocked } from '../common/blocks.js';
import { FriendRequest, User } from '../database/entities/index.js';
import { areFriends, befriend, pair } from './friendship.js';

/** Friend requests a user may send per rolling 24 hours (all kinds count). */
export const FRIEND_REQUESTS_PER_DAY = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class FriendsService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /**
   * Sends a friend request to a user, an email or a phone number.
   *
   * By email or phone the answer is always "sent", and nothing observable changes, whether or
   * not anyone uses that address: the endpoint can't be used to find out who is registered.
   * The request is delivered to whoever has (or later gets) that verified email or phone.
   * By user id (someone you already know from a group) the answer can say "already friends",
   * or "accepted" when they had already asked you.
   * Requests between people where either has blocked the other are silently dropped.
   */
  async request(user: User, input: FriendRequestInput): Promise<FriendRequestResult> {
    return this.db.transaction(async (tx) => {
      await tx.query('select 1 from users where id = $1 for update', [user.id]);
      const [recent] = await tx.query<Array<{ n: number }>>(
        `select count(*)::int as n from friend_requests
         where from_user_id = $1 and created_at > now() - interval '24 hours'`,
        [user.id],
      );
      if ((recent?.n ?? 0) >= FRIEND_REQUESTS_PER_DAY) {
        throw new HttpException(
          { code: 'rate_limited', message: 'Too many friend requests today; try again tomorrow' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      if ('userId' in input) {
        return this.requestUser(tx, user, input.userId);
      }

      const email = 'email' in input ? input.email : null;
      const phone = 'phone' in input ? input.phone : null;
      if ((email && email === user.email) || (phone && phone === user.phone)) {
        return { status: 'sent' };
      }
      const match = await tx.getRepository(User).findOne({
        where: email ? { email } : { phone: phone! },
      });
      if (match && (await eitherBlocked(tx, user.id, match.id))) {
        // dropped, but counted against the daily limit like any other request
        await tx.getRepository(FriendRequest).insert({
          fromUserId: user.id,
          toEmail: email,
          toPhone: phone,
          status: 'cancelled',
          respondedAt: new Date(),
        });
        return { status: 'sent' };
      }
      await tx
        .getRepository(FriendRequest)
        .createQueryBuilder()
        .insert()
        .values({ fromUserId: user.id, toEmail: email, toPhone: phone, status: 'pending' })
        .orIgnore() // already pending to this address
        .execute();
      return { status: 'sent' };
    });
  }

  private async requestUser(
    tx: EntityManager,
    user: User,
    toUserId: string,
  ): Promise<FriendRequestResult> {
    if (toUserId === user.id) {
      throw new BadRequestException({ code: 'self', message: "You can't add yourself" });
    }
    const target = await tx.getRepository(User).findOneBy({ id: toUserId });
    if (!target || target.deletedAt || (await eitherBlocked(tx, user.id, toUserId))) {
      return { status: 'sent' }; // indistinguishable from a real request
    }
    if (await areFriends(tx, user.id, toUserId)) {
      return { status: 'already_friends' };
    }
    const theyAsked = await this.incomingQuery(tx, user)
      .andWhere('r.from_user_id = :from', { from: toUserId })
      .getExists();
    if (theyAsked) {
      await befriend(tx, user.id, toUserId, 'request');
      return { status: 'accepted' };
    }
    await tx
      .getRepository(FriendRequest)
      .createQueryBuilder()
      .insert()
      .values({ fromUserId: user.id, toUserId, status: 'pending' })
      .orIgnore()
      .execute();
    return { status: 'sent' };
  }

  /** Pending requests addressed to this user directly or to their verified email or phone. */
  private incomingQuery(manager: EntityManager, user: User) {
    return manager
      .getRepository(FriendRequest)
      .createQueryBuilder('r')
      .where('r.status = :pending', { pending: 'pending' })
      .andWhere('r.from_user_id <> :me', { me: user.id })
      .andWhere(
        `(r.to_user_id = :me
          or (:email::citext is not null and r.to_email = :email::citext)
          or (:phone::text is not null and r.to_phone = :phone::text))`,
        { email: user.email, phone: user.phone },
      )
      .andWhere(
        `not exists (select 1 from blocks b
                     where (b.blocker_id = r.from_user_id and b.blocked_id = :me)
                        or (b.blocker_id = :me and b.blocked_id = r.from_user_id))`,
      );
  }

  async listRequests(user: User): Promise<FriendRequestsResponse> {
    const incoming = await this.incomingQuery(this.db.manager, user)
      .innerJoin(User, 'u', 'u.id = r.from_user_id')
      .select(['r.id as id', 'u.id as user_id', 'u.name as name', 'r.created_at as created_at'])
      .orderBy('r.created_at', 'DESC')
      .getRawMany<{ id: string; user_id: string; name: string; created_at: Date }>();
    const outgoing = await this.db.query<
      Array<{
        id: string;
        to_user_id: string | null;
        name: string | null;
        to_email: string | null;
        to_phone: string | null;
        created_at: Date;
      }>
    >(
      `select r.id, r.to_user_id, u.name, r.to_email, r.to_phone, r.created_at
       from friend_requests r
       left join users u on u.id = r.to_user_id
       where r.from_user_id = $1 and r.status = 'pending'
       order by r.created_at desc`,
      [user.id],
    );
    return {
      incoming: incoming.map((r): FriendRequestView => ({
        id: r.id,
        person: { userId: r.user_id, name: r.name },
        createdAt: r.created_at.toISOString(),
      })),
      outgoing: outgoing.map((r): FriendRequestView => ({
        id: r.id,
        // only reveal who it is once it was sent to a known user
        person: { userId: r.to_user_id, name: r.name ?? mask(r.to_email, r.to_phone) },
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  async accept(user: User, requestId: string): Promise<{ friendUserId: string }> {
    return this.db.transaction(async (tx) => {
      const request = await this.incoming(tx, user, requestId);
      await befriend(tx, user.id, request.fromUserId, 'request');
      return { friendUserId: request.fromUserId };
    });
  }

  /** Declines quietly: the sender's request just stops showing as pending. */
  async decline(user: User, requestId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const request = await this.incoming(tx, user, requestId);
      await tx
        .getRepository(FriendRequest)
        .update(
          { id: request.id },
          { status: 'declined', respondedAt: new Date(), toUserId: user.id },
        );
    });
  }

  async cancel(user: User, requestId: string): Promise<void> {
    const result = UUID.test(requestId)
      ? await this.db
          .getRepository(FriendRequest)
          .update(
            { id: requestId, fromUserId: user.id, status: 'pending' },
            { status: 'cancelled', respondedAt: new Date() },
          )
      : { affected: 0 };
    if (!result.affected) throw new NotFoundException('Friend request not found');
  }

  private async incoming(tx: EntityManager, user: User, requestId: string): Promise<FriendRequest> {
    const request = UUID.test(requestId)
      ? await this.incomingQuery(tx, user)
          .andWhere('r.id = :id', { id: requestId })
          .setLock('pessimistic_write')
          .getOne()
      : null;
    if (!request) throw new NotFoundException('Friend request not found');
    return request;
  }

  /**
   * Explicit friends, everyone you share (or shared) a group with, and anyone you have a
   * friend-to-friend group with (it may still hold money between you), minus anyone in a block.
   */
  async list(user: User): Promise<Friend[]> {
    const rows = await this.db.query<
      Array<{
        id: string;
        name: string;
        avatar_url: string | null;
        is_friend: boolean;
        shares_group: boolean;
        direct_group_id: string | null;
      }>
    >(
      `with explicit as (
         select case when user_a = $1 then user_b else user_a end as uid
         from friendships where user_a = $1 or user_b = $1
       ), co as (
         select distinct b.user_id as uid
         from group_members a
         join group_members b on b.group_id = a.group_id
         join groups g on g.id = a.group_id and g.type <> 'direct'
         where a.user_id = $1 and b.user_id is not null and b.user_id <> $1
       ), pair as (
         select other.user_id as uid
         from group_members me
         join groups g on g.id = me.group_id and g.type = 'direct'
         join group_members other on other.group_id = g.id and other.user_id <> $1
         where me.user_id = $1
       ), everyone as (
         select uid from explicit union select uid from co union select uid from pair
       )
       select u.id, u.name, u.avatar_url,
              exists (select 1 from explicit e where e.uid = u.id) as is_friend,
              exists (select 1 from co c where c.uid = u.id) as shares_group,
              (select g.id from groups g
               where g.direct_key = least($1::text, u.id::text) || ':' || greatest($1::text, u.id::text)) as direct_group_id
       from everyone
       join users u on u.id = everyone.uid
       where u.deleted_at is null
         and not exists (select 1 from blocks b
                         where (b.blocker_id = $1 and b.blocked_id = u.id)
                            or (b.blocker_id = u.id and b.blocked_id = $1))
       order by lower(u.name), u.id`,
      [user.id],
    );
    return rows.map((r) => ({
      userId: r.id,
      name: r.name,
      avatarUrl: r.avatar_url,
      isFriend: r.is_friend,
      sharesGroup: r.shares_group,
      directGroupId: r.direct_group_id,
    }));
  }

  /** Ends an explicit friendship. Shared groups and the friend-to-friend group are untouched. */
  async unfriend(user: User, friendId: string): Promise<void> {
    if (!UUID.test(friendId)) return;
    const [a, b] = pair(user.id, friendId);
    await this.db.query('delete from friendships where user_a = $1 and user_b = $2', [a, b]);
  }
}

/** "a•••@gmail.com" / "+91•••••3210": enough to recognise, not to read off. */
export function mask(email: string | null, phone: string | null): string {
  if (email) {
    const [local = '', domain = ''] = email.split('@');
    return `${local.slice(0, 1)}•••@${domain}`;
  }
  if (phone) return `${phone.slice(0, 3)}•••••${phone.slice(-4)}`;
  return 'Someone';
}
