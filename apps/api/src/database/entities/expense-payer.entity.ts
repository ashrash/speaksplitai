import { Column, Entity, PrimaryColumn } from 'typeorm';
import { minorUnitsTransformer } from '../transformers.js';

@Entity('expense_payers')
export class ExpensePayer {
  @PrimaryColumn('uuid')
  expenseId: string;

  @PrimaryColumn('uuid')
  memberId: string;

  /** Part of both composite foreign keys; kept equal to the expense's group. */
  @Column('uuid')
  groupId: string;

  @Column('bigint', { transformer: minorUnitsTransformer })
  paidMinor: number;
}
