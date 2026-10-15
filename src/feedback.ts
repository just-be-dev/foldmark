import * as Schema from 'effect/Schema'
import { Annotation } from './model'

/** Stable, bounded identifiers are data; they never become filesystem paths. */
export const FeedbackId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
)
export const FeedbackStatus = Schema.Literals(['pending', 'claimed', 'completed', 'failed'])
export type FeedbackStatus = typeof FeedbackStatus.Type
export const FeedbackSubmission = Schema.Struct({
  version: Schema.Literal(1),
  requestId: FeedbackId,
  annotations: Schema.Array(Annotation).check(Schema.isBetweenLength(1, 100)),
})
export interface FeedbackSubmission extends Schema.Schema.Type<typeof FeedbackSubmission> {}
export const FeedbackRequest = Schema.Struct({
  id: FeedbackId,
  projectId: FeedbackId,
  status: FeedbackStatus,
  annotations: Schema.Array(Annotation),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  claim: Schema.NullOr(Schema.Struct({ owner: FeedbackId, expiresAt: Schema.String })),
  result: Schema.NullOr(Schema.Struct({ message: Schema.String })),
})
export interface FeedbackRequest extends Schema.Schema.Type<typeof FeedbackRequest> {}
export const FeedbackClaimInput = Schema.Struct({
  owner: FeedbackId,
  leaseMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 15_000, maximum: 3_600_000 })),
  ),
  claimToken: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(32, 256))),
})
export interface FeedbackClaimInput extends Schema.Schema.Type<typeof FeedbackClaimInput> {}
export const FeedbackClaimResult = Schema.Struct({
  request: FeedbackRequest,
  claimToken: Schema.String,
})
export interface FeedbackClaimResult extends Schema.Schema.Type<typeof FeedbackClaimResult> {}
export const FeedbackCompleteInput = Schema.Struct({
  claimToken: Schema.String.check(Schema.isBetweenLength(32, 256)),
  status: Schema.Literals(['completed', 'failed']),
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_000))),
})
export interface FeedbackCompleteInput extends Schema.Schema.Type<typeof FeedbackCompleteInput> {}
export const FeedbackEvent = Schema.Struct({
  cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  requestId: FeedbackId,
  status: FeedbackStatus,
  updatedAt: Schema.String,
  cause: Schema.optionalKey(
    Schema.Literals(['submission', 'claim', 'renewal', 'completion', 'lease_expired']),
  ),
})
export interface FeedbackEvent extends Schema.Schema.Type<typeof FeedbackEvent> {}
export const FeedbackEvents = Schema.Struct({
  cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reset: Schema.Boolean,
  events: Schema.Array(FeedbackEvent),
})
export interface FeedbackEvents extends Schema.Schema.Type<typeof FeedbackEvents> {}
export const FeedbackList = Schema.Struct({ requests: Schema.Array(FeedbackRequest) })
