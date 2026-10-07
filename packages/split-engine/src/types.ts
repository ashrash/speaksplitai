/** Money is always an integer number of paise (1 INR = 100 paise). Never a float. */
export type Paise = number;

/** Mirrors `expenses.split_type` in docs/schema.md. */
export const SPLIT_TYPES = [
  'equal',
  'exact',
  'percent',
  'shares',
  'adjustment',
  'itemized',
] as const;
export type SplitType = (typeof SPLIT_TYPES)[number];

/** A group member's id (`group_members.id`), not a user id, so placeholders work too. */
export type MemberId = string;
