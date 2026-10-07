import { AuditLog } from './audit-log.entity.js';
import { Currency } from './currency.entity.js';
import { ExpensePayer } from './expense-payer.entity.js';
import { ExpenseSplit } from './expense-split.entity.js';
import { Expense } from './expense.entity.js';
import { GroupMember } from './group-member.entity.js';
import { Group } from './group.entity.js';
import { IdempotencyKey } from './idempotency-key.entity.js';
import { Invite } from './invite.entity.js';
import { Settlement } from './settlement.entity.js';
import { UserUpiId } from './user-upi-id.entity.js';
import { User } from './user.entity.js';

export {
  AuditLog,
  Currency,
  Expense,
  ExpensePayer,
  ExpenseSplit,
  Group,
  GroupMember,
  IdempotencyKey,
  Invite,
  Settlement,
  User,
  UserUpiId,
};

/**
 * Entities mirror the migrations; they never generate schema. Tables not listed here
 * (items, blocks, attachments, comments, push tokens, recurring expenses, exchange
 * rates) get entities with the features that use them.
 */
export const ENTITIES = [
  AuditLog,
  Currency,
  Expense,
  ExpensePayer,
  ExpenseSplit,
  Group,
  GroupMember,
  IdempotencyKey,
  Invite,
  Settlement,
  User,
  UserUpiId,
];
