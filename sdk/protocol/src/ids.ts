import { z } from "zod";

export const uuidStringSchema = z.string().uuid();
export const externalUserIdSchema = z.string().min(1).max(128);
export const clientMessageIdSchema = z.string().min(1).max(128);
export const requestIdValueSchema = z.string().min(1).max(128);
