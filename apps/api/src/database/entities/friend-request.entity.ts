import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** A friend request to a known user, or to an email or phone that may match someone later. */
@Entity('friend_requests')
export class FriendRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  fromUserId: string;

  @Column('uuid', { nullable: true })
  toUserId: string | null;

  @Column('citext', { nullable: true })
  toEmail: string | null;

  @Column('text', { nullable: true })
  toPhone: string | null;

  @Column('text')
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column('timestamptz', { nullable: true })
  respondedAt: Date | null;
}
