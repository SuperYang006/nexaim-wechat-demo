import { z } from "zod";
import { errorCodes } from "./errors";

export const requestIdSchema = z.string().min(1);

const errorCodeValues = Object.keys(errorCodes) as [
  keyof typeof errorCodes,
  ...(keyof typeof errorCodes)[]
];

export const errorResponseSchema = z.object({
  requestId: requestIdSchema,
  error: z.object({
    code: z.enum(errorCodeValues),
    message: z.string().min(1),
    details: z.record(z.unknown()).optional()
  })
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export type SuccessPage = {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
};

export function successResponse<T>(
  requestId: string,
  data: T,
  page?: SuccessPage
) {
  // Omit `page` when the caller didn't supply one so single-resource
  // endpoints stay a flat `{ requestId, data }`. List endpoints pass
  // `page` to opt into the `{ requestId, data, page }` shape from
  // docs/API接口设计规范.md § 7.
  return page ? { requestId, data, page } : { requestId, data };
}

export function errorResponse(
  requestId: string,
  error: ErrorResponse["error"]
) {
  return { requestId, error };
}
