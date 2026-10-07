import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('currencies')
export class Currency {
  @PrimaryColumn('char', { length: 3 })
  code: string;

  @Column('smallint')
  minorUnit: number;

  @Column('text')
  name: string;
}
