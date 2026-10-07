import { Column, Entity, PrimaryColumn } from 'typeorm';
import { minorUnitsTransformer } from '../transformers.js';

@Entity('expense_splits')
export class ExpenseSplit {
  @PrimaryColumn('uuid')
  expenseId: string;

  @PrimaryColumn('uuid')
  memberId: string;

  @Column('uuid')
  groupId: string;

  @Column('bigint', { transformer: minorUnitsTransformer })
  owedMinor: number;

  /** Percent or share units as entered; a decimal string, never a JS float. */
  @Column('numeric', { precision: 12, scale: 4, nullable: true })
  shareValue: string | null;

  @Column('bigint', { nullable: true, transformer: minorUnitsTransformer })
  adjustmentMinor: number | null;
}
