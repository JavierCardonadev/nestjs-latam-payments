import { PaymentValidationError } from './errors.js';
import { assertMinorUnits, normalizeCurrency } from './money.js';
import type { BillingInterval, InlinePlan, SubscriptionStatus, SubscriptionEventType } from './types.js';

const INTERVALS = new Set<BillingInterval>(['day', 'week', 'month', 'year']);

function assertCount(value: number | undefined, field: string, min: number): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < min)) {
    throw new PaymentValidationError(`${field} must be an integer >= ${min}; received ${value}`);
  }
}

/** Validates and normalizes a plan definition. */
export function normalizePlan<T extends InlinePlan>(plan: T): T & { currency: string; intervalCount: number } {
  if (!plan || typeof plan.name !== 'string' || plan.name.trim() === '') {
    throw new PaymentValidationError('plan name is required');
  }
  assertMinorUnits(plan.amount);
  if (!INTERVALS.has(plan.interval)) {
    throw new PaymentValidationError(`plan interval must be one of ${[...INTERVALS].join(', ')}`);
  }
  assertCount(plan.intervalCount, 'intervalCount', 1);
  assertCount(plan.trialDays, 'trialDays', 0);
  assertCount(plan.totalCycles, 'totalCycles', 1);
  return { ...plan, currency: normalizeCurrency(plan.currency), intervalCount: plan.intervalCount ?? 1 };
}

/** Event type for a subscription that is now in `status`. */
export function subscriptionEventForStatus(status: SubscriptionStatus): SubscriptionEventType {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'subscription.activated';
    default:
      return `subscription.${status}`;
  }
}
