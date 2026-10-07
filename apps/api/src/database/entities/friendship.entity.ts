import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/** One row per pair of friends, stored with user_a < user_b. */
@Entity('friendships')
export class Friendship {
  @PrimaryColumn('uuid')
  userA: string;

  @PrimaryColumn('uuid')
  userB: string;

  @Column('text')
  source: 'invite' | 'request';

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
