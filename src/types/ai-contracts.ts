/**
 * AI Service Data Contracts & Runtime Validation Schemas
 *
 * Enforces cryptographic request fingerprinting, idempotency keys,
 * and quota reservation/settlement lifecycle contracts.
 *
 * Remediates: LUGX-067, LUGX-115, LUGX-116, LUGX-119
 */

import { z } from 'zod';

/**
 * AI Request Payload Contract
 * Requires operationId and requestHash for replay defense and idempotency.
 */
export interface AIRequestContract {
  /** Unique idempotent operation UUID */
  readonly operationId: string;
  /** SHA-256 fingerprint of prompt + configuration */
  readonly requestHash: string;
  /** Prompt input text */
  readonly prompt: string;
  /** Optional associated file UUID */
  readonly fileId?: string;
  /** Optional system instructions */
  readonly systemPrompt?: string;
  /** Requested model identifier */
  readonly model?: string;
  /** Whether streaming response is requested */
  readonly stream?: boolean;
  /** Timestamp when request was initiated */
  readonly clientTimestamp: number;
}

export const aiRequestSchema = z.object({
  operationId: z.string().min(1),
  requestHash: z.string().length(64), // SHA-256 hex string
  prompt: z.string().min(1),
  fileId: z.string().uuid().optional(),
  systemPrompt: z.string().optional(),
  model: z.string().min(1).optional(),
  stream: z.boolean().optional(),
  clientTimestamp: z.number().int().positive(),
}).strict();

/**
 * AI Quota Reservation Contract
 */
export interface AIReservationContract {
  readonly reservationId: string;
  readonly operationId: string;
  readonly userId: string;
  readonly requestHash: string;
  readonly estimatedTokens: number;
  readonly creditsReserved: number;
  readonly expiresAt: number;
}

export const aiReservationSchema = z.object({
  reservationId: z.string().min(1),
  operationId: z.string().min(1),
  userId: z.string().min(1),
  requestHash: z.string().length(64),
  estimatedTokens: z.number().int().positive(),
  creditsReserved: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
}).strict();

/**
 * AI Quota Commitment Contract
 */
export interface AICommitReservationContract {
  readonly reservationId: string;
  readonly operationId: string;
  readonly requestHash: string;
  readonly actualTokensUsed: number;
  readonly creditsDeducted: number;
}

export const aiCommitReservationSchema = z.object({
  reservationId: z.string().min(1),
  operationId: z.string().min(1),
  requestHash: z.string().length(64),
  actualTokensUsed: z.number().int().nonnegative(),
  creditsDeducted: z.number().int().nonnegative(),
}).strict();

/**
 * AI Quota Refund Contract
 */
export interface AIRefundReservationContract {
  readonly reservationId: string;
  readonly operationId: string;
  readonly requestHash: string;
  readonly reason: string;
}

export const aiRefundReservationSchema = z.object({
  reservationId: z.string().min(1),
  operationId: z.string().min(1),
  requestHash: z.string().length(64),
  reason: z.string().min(1),
}).strict();

/**
 * AI User Quota Status Contract
 */
export interface AIQuotaStatusContract {
  readonly allowed: boolean;
  readonly remainingQuota: number;
  readonly tier: string;
  readonly resetAt: number;
}

export const aiQuotaStatusSchema = z.object({
  allowed: z.boolean(),
  remainingQuota: z.number().int().nonnegative(),
  tier: z.string().min(1),
  resetAt: z.number().int().positive(),
}).strict();
