import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** A shareable invite link. Only sha256(token) is stored; the raw token lives in the link. */
@Entity('invites')
export class Invite {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 'group': join groupId. 'friend': become friends with the creator (no group). */
  @Column('text')
  kind: 'group' | 'friend';

  @Column('uuid', { nullable: true })
  groupId: string | null;

  @Column('bytea')
  tokenHash: Buffer;

  @Column('citext', { nullable: true })
  targetEmail: string | null;

  @Column('text', { nullable: true })
  targetPhone: string | null;

  /** Set when the invite is for claiming a placeholder member (always single use). */
  @Column('uuid', { nullable: true })
  placeholderMemberId: string | null;

  @Column('uuid')
  createdBy: string;

  @Column('integer', { nullable: true })
  maxUses: number | null;

  @Column('integer')
  useCount: number;

  @Column('timestamptz')
  expiresAt: Date;

  @Column('timestamptz', { nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
