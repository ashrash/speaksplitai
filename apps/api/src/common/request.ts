import type { Request } from 'express';
import type { GroupMember } from '../database/entities/index.js';
import type { User } from '../database/entities/index.js';

/** Express request after the auth and group-access guards have run. */
export interface AppRequest extends Request {
  id: string;
  user?: User;
  membership?: GroupMember;
}
