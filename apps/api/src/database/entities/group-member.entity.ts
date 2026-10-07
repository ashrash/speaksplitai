import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

@Entity('group_members')
export class GroupMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  groupId: string;

  /** Null for a placeholder member who hasn't joined yet. */
  @Column('uuid', { nullable: true })
  userId: string | null;

  @Column('text', { nullable: true })
  placeholderName: string | null;

  @Column('text')
  role: MemberRole;

  @Column('text')
  notifyLevel: 'all' | 'important' | 'none';

  @Column('timestamptz', { nullable: true })
  mutedUntil: Date | null;

  @Column('uuid', { nullable: true })
  invitedBy: string | null;

  @Column('uuid', { nullable: true })
  removedBy: string | null;

  @Column('timestamptz')
  joinedAt: Date;

  @Column('timestamptz', { nullable: true })
  claimedAt: Date | null;

  /** Set when the member leaves or is removed; they keep read-only access. */
  @Column('timestamptz', { nullable: true })
  leftAt: Date | null;
}
