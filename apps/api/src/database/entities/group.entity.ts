import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

export const GROUP_TYPES = [
  'trip',
  'flat',
  'couple',
  'friends',
  'event',
  'other',
  'direct',
] as const;
export type GroupType = (typeof GROUP_TYPES)[number];

@Entity('groups')
export class Group {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('text')
  name: string;

  @Column('text')
  type: GroupType;

  @Column('char', { length: 3 })
  defaultCurrency: string;

  @Column('boolean')
  simplifyDebts: boolean;

  /** Sorted '<userA>:<userB>' for type = 'direct'. */
  @Column('text', { nullable: true })
  directKey: string | null;

  @Column('uuid')
  createdBy: string;

  @VersionColumn()
  version: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column('timestamptz', { nullable: true })
  archivedAt: Date | null;
}
