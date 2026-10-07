import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import type { SplitType } from '@speaksplit/split-engine';
import { minorUnitsTransformer } from '../transformers.js';

@Entity('expenses')
export class Expense {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  groupId: string;

  @Column('text')
  description: string;

  @Column('text', { nullable: true })
  category: string | null;

  @Column('text', { nullable: true })
  notes: string | null;

  @Column('bigint', { transformer: minorUnitsTransformer })
  totalMinor: number;

  @Column('char', { length: 3 })
  currency: string;

  @Column('date')
  expenseDate: string;

  @Column('text')
  splitType: SplitType;

  @Column('text')
  source: 'manual' | 'text' | 'voice' | 'image' | 'image_text' | 'recurring';

  @Column('uuid', { nullable: true })
  recurringExpenseId: string | null;

  @Column('uuid')
  createdBy: string;

  @Column('uuid', { nullable: true })
  updatedBy: string | null;

  @Column('uuid', { nullable: true })
  deletedBy: string | null;

  @VersionColumn()
  version: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column('timestamptz', { nullable: true })
  deletedAt: Date | null;
}
