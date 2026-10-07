import { SPLIT_TYPES } from '@speaksplit/split-engine';
import { z } from 'zod';

export const paiseSchema = z.number().int();
export const uuidSchema = z.uuid();
export const splitTypeSchema = z.enum(SPLIT_TYPES);

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
