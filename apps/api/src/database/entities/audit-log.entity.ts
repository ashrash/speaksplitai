import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type AuditEntity = 'group' | 'member' | 'expense' | 'settlement' | 'invite' | 'comment';
export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'restore'
  | 'join'
  | 'leave'
  | 'remove'
  | 'role_change'
  | 'claim'
  | 'confirm'
  | 'dispute'
  | 'cancel';

/** Append-only (a trigger rejects UPDATE and DELETE). `diff` holds ids and amounts, never PII. */
@Entity('audit_log')
export class AuditLog {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id: string;

  @Column('uuid', { nullable: true })
  groupId: string | null;

  @Column('text')
  entity: AuditEntity;

  @Column('uuid')
  entityId: string;

  @Column('uuid', { nullable: true })
  actorId: string | null;

  @Column('text')
  action: AuditAction;

  @Column('jsonb', { nullable: true })
  diff: Record<string, unknown> | null;

  @Column('text', { nullable: true })
  requestId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
