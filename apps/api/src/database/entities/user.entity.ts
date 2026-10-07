import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Auth0 `sub`. */
  @Column('text')
  authSubject: string;

  @Column('text')
  name: string;

  @Column('citext', { nullable: true })
  email: string | null;

  @Column('text', { nullable: true })
  phone: string | null;

  @Column('text', { nullable: true })
  avatarUrl: string | null;

  @Column('text')
  locale: string;

  @Column('char', { length: 3 })
  defaultCurrency: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column('timestamptz', { nullable: true })
  deletedAt: Date | null;
}
