import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('user_upi_ids')
export class UserUpiId {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @Column('text')
  vpa: string;

  @Column('text', { nullable: true })
  label: string | null;

  @Column('boolean')
  isPrimary: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
