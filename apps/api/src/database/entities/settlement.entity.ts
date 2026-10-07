import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import type { SettlementStatus } from '@speaksplit/split-engine';
import { minorUnitsTransformer } from '../transformers.js';

@Entity('settlements')
export class Settlement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  groupId: string;

  @Column('uuid')
  fromMemberId: string;

  @Column('uuid')
  toMemberId: string;

  /** The debt cleared, in `currency`. */
  @Column('bigint', { transformer: minorUnitsTransformer })
  amountMinor: number;

  @Column('char', { length: 3 })
  currency: string;

  /** What was actually sent, when it was another currency. */
  @Column('bigint', { nullable: true, transformer: minorUnitsTransformer })
  paidAmountMinor: number | null;

  @Column('char', { length: 3, nullable: true })
  paidCurrency: string | null;

  @Column('text')
  method: 'upi' | 'cash' | 'bank_transfer' | 'other';

  @Column('text', { nullable: true })
  upiRef: string | null;

  @Column('text', { nullable: true })
  note: string | null;

  @Column('text')
  status: SettlementStatus;

  @Column('text', { nullable: true })
  disputedReason: string | null;

  @Column('uuid')
  createdBy: string;

  @Column('uuid', { nullable: true })
  confirmedBy: string | null;

  @Column('timestamptz', { nullable: true })
  confirmedAt: Date | null;

  @VersionColumn()
  version: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
