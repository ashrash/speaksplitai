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

/** Raw invite tokens are 32 random bytes, base64url. */
export const inviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const createInviteRequestSchema = z.object({
  /** Omit for unlimited uses until expiry. Placeholder invites are always single use. */
  maxUses: z.number().int().min(1).max(100).optional(),
  expiresInHours: z.number().int().min(1).max(720).default(168),
  /** Invite a specific person to take over a placeholder member (and its history). */
  placeholderMemberId: uuidSchema.optional(),
});
export type CreateInviteRequest = z.input<typeof createInviteRequestSchema>;

export const inviteResponseSchema = z.object({
  id: uuidSchema,
  /** Only returned when the invite is created; it is not stored and can't be shown again. */
  token: z.string().optional(),
  /** `${PUBLIC_APP_URL}/join/${token}` when the server knows its public URL. */
  url: z.string().nullable().optional(),
  expiresAt: z.string(),
  maxUses: z.number().int().nullable(),
  useCount: z.number().int(),
  placeholder: z.object({ memberId: uuidSchema, name: z.string() }).nullable(),
  createdBy: z.object({ userId: uuidSchema, name: z.string() }),
  createdAt: z.string(),
});
export type InviteResponse = z.infer<typeof inviteResponseSchema>;

/** What someone sees before accepting an invite. */
export const invitePreviewSchema = z.object({
  /** 'group': join the group below. 'friend': become friends with the person who sent it. */
  kind: z.enum(['group', 'friend']),
  group: z
    .object({ id: uuidSchema, name: z.string(), type: z.string(), memberCount: z.number().int() })
    .nullable(),
  invitedBy: z.string(),
  placeholderName: z.string().nullable(),
  expiresAt: z.string(),
  /** Already in the group (group invites) or already friends (friend invites). */
  alreadyMember: z.boolean(),
});
export type InvitePreview = z.infer<typeof invitePreviewSchema>;

export const acceptInviteResponseSchema = z.object({
  kind: z.enum(['group', 'friend']),
  /** Group invites. */
  groupId: uuidSchema.nullable(),
  memberId: uuidSchema.nullable(),
  /** Friend invites: the person you are now friends with. */
  friendUserId: uuidSchema.nullable(),
  /**
   * joined: new member; rejoined: was a former member; claimed: took over a placeholder;
   * befriended: new friend; already: no change.
   */
  outcome: z.enum(['joined', 'rejoined', 'claimed', 'befriended', 'already']),
});
export type AcceptInviteResponse = z.infer<typeof acceptInviteResponseSchema>;

export const addPlaceholderRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const createFriendInviteRequestSchema = z.object({
  maxUses: z.number().int().min(1).max(100).optional(),
  expiresInHours: z.number().int().min(1).max(720).default(168),
});

/** E.164 phone number, e.g. +919876543210. */
export const phoneSchema = z
  .string()
  .regex(/^\+[1-9][0-9]{7,14}$/, 'a phone number with country code, like +919876543210');

/** Exactly one of userId, email or phone. */
export const friendRequestSchema = z.union([
  z.object({ userId: uuidSchema }).strict(),
  z.object({ email: z.email().transform((e) => e.trim().toLowerCase()) }).strict(),
  z.object({ phone: phoneSchema }).strict(),
]);
export type FriendRequestInput = z.input<typeof friendRequestSchema>;

/**
 * For email and phone the answer is always 'sent', whether or not anyone uses that address, so
 * the endpoint can't be used to find out who is registered.
 */
export const friendRequestResultSchema = z.object({
  status: z.enum(['sent', 'accepted', 'already_friends']),
});
export type FriendRequestResult = z.infer<typeof friendRequestResultSchema>;

export const friendRequestViewSchema = z.object({
  id: uuidSchema,
  /** Incoming: who asked. Outgoing: who you asked (a masked address if not matched yet). */
  person: z.object({ userId: uuidSchema.nullable(), name: z.string() }),
  createdAt: z.string(),
});
export type FriendRequestView = z.infer<typeof friendRequestViewSchema>;

export const friendRequestsResponseSchema = z.object({
  incoming: z.array(friendRequestViewSchema),
  outgoing: z.array(friendRequestViewSchema),
});
export type FriendRequestsResponse = z.infer<typeof friendRequestsResponseSchema>;

export const friendSchema = z.object({
  userId: uuidSchema,
  name: z.string(),
  avatarUrl: z.string().nullable(),
  /** An explicit friend (by invite link or accepted request). */
  isFriend: z.boolean(),
  /** You share, or shared, a group. */
  sharesGroup: z.boolean(),
  /** The friend-to-friend group, if it has been opened. */
  directGroupId: uuidSchema.nullable(),
});
export type Friend = z.infer<typeof friendSchema>;

// ---- Expenses ----

export const EXPENSE_CATEGORIES = [
  'food',
  'groceries',
  'travel',
  'transport',
  'stay',
  'rent',
  'utilities',
  'household',
  'staff',
  'entertainment',
  'shopping',
  'health',
  'other',
] as const;
export const expenseCategorySchema = z.enum(EXPENSE_CATEGORIES);

export const EXPENSE_SOURCES = ['manual', 'text', 'voice', 'image', 'image_text'] as const;

/** Non-negative decimal with at most 4 places (fits numeric(12,4)), e.g. "33.3333" or "2". */
export const shareDecimalSchema = z
  .string()
  .regex(/^\d{1,8}(\.\d{1,4})?$/, 'a number with at most 4 decimal places, as a string');

const positiveMinor = minorUnitsSchema.refine((n) => n > 0, 'must be positive');
const nonNegativeMinor = minorUnitsSchema.refine((n) => n >= 0, 'must not be negative');

/**
 * How to split. Member order doesn't matter: the server always splits in the order members
 * joined the group, so leftover minor units go to the same people on every device.
 */
export const expenseSplitSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('equal'), memberIds: z.array(uuidSchema).min(1) }),
  z.object({
    type: z.literal('exact'),
    amounts: z.array(z.object({ memberId: uuidSchema, amountMinor: nonNegativeMinor })).min(1),
  }),
  z.object({
    type: z.literal('percent'),
    percents: z.array(z.object({ memberId: uuidSchema, percent: shareDecimalSchema })).min(1),
  }),
  z.object({
    type: z.literal('shares'),
    shares: z.array(z.object({ memberId: uuidSchema, shares: shareDecimalSchema })).min(1),
  }),
  z.object({
    type: z.literal('adjustment'),
    adjustments: z
      .array(z.object({ memberId: uuidSchema, adjustmentMinor: minorUnitsSchema }))
      .min(1),
  }),
]);
export type ExpenseSplitInput = z.infer<typeof expenseSplitSchema>;

export const expenseRequestSchema = z.object({
  description: z.string().trim().min(1).max(200),
  category: expenseCategorySchema.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  totalMinor: positiveMinor,
  /** Defaults to the group's default currency. */
  currency: currencySchema.optional(),
  /** The day it was spent, as the user sees it (YYYY-MM-DD). */
  expenseDate: z.iso.date(),
  /** Who paid how much; must add up to the total. */
  payers: z.array(z.object({ memberId: uuidSchema, paidMinor: positiveMinor })).min(1),
  split: expenseSplitSchema,
  source: z.enum(EXPENSE_SOURCES).default('manual'),
});
export type ExpenseRequest = z.input<typeof expenseRequestSchema>;

/** Edits send the whole expense again, plus the version they started from. */
export const updateExpenseRequestSchema = expenseRequestSchema.extend({
  version: z.number().int().positive(),
});
export type UpdateExpenseRequest = z.input<typeof updateExpenseRequestSchema>;

export const listExpensesQuerySchema = z.object({
  /** mine (default): expenses you paid for or are part of. all: every expense in the group. */
  scope: z.enum(['mine', 'all']).default('mine'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
});

export const expenseMemberAmountSchema = z.object({
  memberId: uuidSchema,
  name: z.string(),
});

export const expenseDetailSchema = z.object({
  id: uuidSchema,
  groupId: uuidSchema,
  description: z.string(),
  category: expenseCategorySchema.nullable(),
  notes: z.string().nullable(),
  totalMinor: z.number().int(),
  currency: currencySchema,
  expenseDate: z.string(),
  splitType: splitTypeSchema,
  source: z.string(),
  version: z.number().int(),
  createdBy: z.object({ userId: uuidSchema, name: z.string() }),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  payers: z.array(expenseMemberAmountSchema.extend({ paidMinor: z.number().int() })),
  splits: z.array(
    expenseMemberAmountSchema.extend({
      owedMinor: z.number().int(),
      /** The percent or share units as entered. */
      shareValue: z.string().nullable(),
      adjustmentMinor: z.number().int().nullable(),
    }),
  ),
});
export type ExpenseDetail = z.infer<typeof expenseDetailSchema>;

export const expenseListItemSchema = z.object({
  id: uuidSchema,
  description: z.string(),
  category: expenseCategorySchema.nullable(),
  totalMinor: z.number().int(),
  currency: currencySchema,
  expenseDate: z.string(),
  splitType: splitTypeSchema,
  createdAt: z.string(),
  /** The caller's own part: what they paid, what they owe, and paid minus owed. */
  mine: z.object({
    paidMinor: z.number().int(),
    owedMinor: z.number().int(),
    netMinor: z.number().int(),
  }),
});
export type ExpenseListItem = z.infer<typeof expenseListItemSchema>;

export const expenseListResponseSchema = z.object({
  items: z.array(expenseListItemSchema),
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: z.string().nullable(),
});
export type ExpenseListResponse = z.infer<typeof expenseListResponseSchema>;
