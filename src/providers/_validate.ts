import { raiseError } from "../raiseError.js";

/**
 * Reject NaN / Infinity / negative values for numeric provider options.
 *
 * Shared across {@link FlagsmithProvider}, {@link UnleashProvider},
 * {@link LaunchDarklyProvider} so the rejection message is uniform across
 * providers — only the `provider` label changes.
 */
export function assertFiniteNonNegative(provider: string, name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    raiseError(
      `${provider}: \`${name}\` must be a finite non-negative number; got ${String(value)}.`,
    );
  }
}

/**
 * Strict-positive variant — used for timer-bounding options where `0`
 * is ambiguous (treated as "no timeout" by some SDK versions).
 */
export function assertFinitePositive(provider: string, name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    raiseError(
      `${provider}: \`${name}\` must be a finite positive number; got ${String(value)}.`,
    );
  }
}
