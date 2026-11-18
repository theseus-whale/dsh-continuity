import { verifyWatermark as verifyGenericWatermark, activationBoundary as genericActivationBoundary } from '../backfill/watermark.mjs';

export function verifyCoverageWatermark(args) {
  return verifyGenericWatermark(args);
}

export function verifyActivationBoundary(args) {
  return genericActivationBoundary(args);
}
