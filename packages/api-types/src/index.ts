import { CURRENCY_CODES, SPLIT_TYPES } from '@speaksplit/split-engine';
import { z } from 'zod';

export const uuidSchema = z.uuid();
export const splitTypeSchema = z.enum(SPLIT_TYPES);
export const currencySchema = z.enum(CURRENCY_CODES);

/** An integer count of the currency's minor unit (paise, cents, yen). Never a float. */
export const minorUnitsSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

/** Amounts always travel with their currency. */
export const moneySchema = z.object({
  amountMinor: minorUnitsSchema,
  currency: currencySchema,
});
export type Money = z.infer<typeof moneySchema>;

/** Percentages, shares and exchange rates travel as decimal strings to avoid float rounding. */
export const decimalStringSchema = z.string().regex(/^-?\d+(\.\d+)?$/, 'expected a decimal string');

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Error responses from the API. */
export const errorResponseSchema = z.object({
  error: z.object({
    status: z.number().int(),
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** A UPI ID (VPA) such as name@okaxis. Same rule as the user_upi_ids_vpa_ck constraint. */
export const vpaSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.-]{1,63}$/,
    'not a valid UPI ID (like name@okaxis)',
  );

export const upiIdSchema = z.object({
  id: uuidSchema,
  vpa: z.string(),
  label: z.string().nullable(),
  isPrimary: z.boolean(),
});
export type UpiId = z.infer<typeof upiIdSchema>;

export const meResponseSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  locale: z.string(),
  defaultCurrency: currencySchema,
  /** Primary first, then oldest first. */
  upiIds: z.array(upiIdSchema),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** Profile edits. Email and phone change through a verified flow, not here. */
export const updateMeRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    avatarUrl: z
      .url({ protocol: /^https$/ })
      .nullable()
      .optional(),
    locale: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'a language tag like en-IN or hi')
      .optional(),
    defaultCurrency: currencySchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'nothing to update' });
export type UpdateMeRequest = z.input<typeof updateMeRequestSchema>;

export const addUpiIdRequestSchema = z.object({
  vpa: vpaSchema,
  label: z.string().trim().min(1).max(40).optional(),
  /** The first UPI ID is always primary; later ones only if asked. */
  isPrimary: z.boolean().optional(),
});
export type AddUpiIdRequest = z.input<typeof addUpiIdRequestSchema>;

export const updateUpiIdRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(40).nullable().optional(),
    /** Only `true` is meaningful: make this the primary. To change primary, set another one. */
    isPrimary: z.literal(true).optional(),
  })
  .refine((v) => v.label !== undefined || v.isPrimary !== undefined, {
    message: 'nothing to update',
  });
export type UpdateUpiIdRequest = z.input<typeof updateUpiIdRequestSchema>;

/** Group types a user can create; 'direct' groups are made by the friend-to-friend flow. */
export const groupTypeSchema = z.enum(['trip', 'flat', 'couple', 'friends', 'event', 'other']);

export const createGroupRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: groupTypeSchema.default('friends'),
  defaultCurrency: currencySchema.default('INR'),
  simplifyDebts: z.boolean().default(true),
});
export type CreateGroupRequest = z.input<typeof createGroupRequestSchema>;

/** Optimistic locking: send the version you last saw; a 409 means someone changed it first. */
export const updateGroupRequestSchema = z
  .object({
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(100).optional(),
    defaultCurrency: currencySchema.optional(),
    simplifyDebts: z.boolean().optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.defaultCurrency !== undefined || v.simplifyDebts !== undefined,
    {
      message: 'nothing to update',
    },
  );
export type UpdateGroupRequest = z.input<typeof updateGroupRequestSchema>;

export const groupMemberSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema.nullable(),
  name: z.string(),
  role: z.enum(['owner', 'admin', 'member']),
  joinedAt: z.string(),
  leftAt: z.string().nullable(),
});

export const groupResponseSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  type: z.string(),
  defaultCurrency: currencySchema,
  simplifyDebts: z.boolean(),
  version: z.number().int(),
  archivedAt: z.string().nullable(),
  /** The caller's own membership: role, and whether they have left (read-only). */
  me: z.object({
    memberId: uuidSchema,
    role: z.enum(['owner', 'admin', 'member']),
    leftAt: z.string().nullable(),
  }),
});
export type GroupResponse = z.infer<typeof groupResponseSchema>;

export const groupDetailResponseSchema = groupResponseSchema.extend({
  members: z.array(groupMemberSchema),
});
export type GroupDetailResponse = z.infer<typeof groupDetailResponseSchema>;

export const listGroupsQuerySchema = z.object({
  status: z.enum(['active', 'archived']).default('active'),
});

/** Opens (or returns) the friend-to-friend group with another user. */
export const openDirectRequestSchema = z.object({ userId: uuidSchema });

export const directGroupResponseSchema = z.object({
  groupId: uuidSchema,
  friend: z.object({ userId: uuidSchema, name: z.string() }),
  defaultCurrency: currencySchema,
  archivedAt: z.string().nullable(),
});
export type DirectGroupResponse = z.infer<typeof directGroupResponseSchema>;
