import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('idempotency_keys')
export class IdempotencyKey {
  @PrimaryColumn('uuid')
  userId: string;

  @PrimaryColumn('text')
  idemKey: string;

  @Column('text')
  method: string;

  @Column('text')
  path: string;

  /** sha256 of method, path and the canonical request body. */
  @Column('bytea')
  requestHash: Buffer;

  @Column('text')
  status: 'in_progress' | 'completed';

  @Column('smallint', { nullable: true })
  responseStatus: number | null;

  @Column('jsonb', { nullable: true })
  responseBody: unknown;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column('timestamptz')
  expiresAt: Date;
}
