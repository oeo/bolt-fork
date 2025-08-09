// currency conversion and formatting utilities
import { WATTS_PER_BOLT } from '../constants';

/**
 * convert watts to BOLT string for display
 * @param watts amount in watts (base unit)
 * @returns formatted string like "50 BOLT" or "50.123 BOLT"
 */
export function wattsToBolt(watts: bigint): string {
  const wholeBolts = watts / WATTS_PER_BOLT;
  const remainingWatts = watts % WATTS_PER_BOLT;
  
  if (remainingWatts === 0n) {
    return `${wholeBolts} BOLT`;
  }
  
  // format with decimal places
  const decimal = remainingWatts.toString().padStart(8, '0');
  // remove trailing zeros
  const trimmed = decimal.replace(/0+$/, '');
  
  if (trimmed === '') {
    return `${wholeBolts} BOLT`;
  }
  
  return `${wholeBolts}.${trimmed} BOLT`;
}

/**
 * format watts for display, automatically choosing watts or BOLT
 * @param watts amount in watts
 * @returns formatted string like "1000 watts" or "50 BOLT"
 */
export function formatWatts(watts: bigint): string {
  if (watts < WATTS_PER_BOLT) {
    return `${watts} ${watts === 1n ? 'watt' : 'watts'}`;
  }
  
  return wattsToBolt(watts);
}

/**
 * convert BOLT amount to watts
 * @param bolt amount in BOLT (can be decimal)
 * @returns amount in watts
 */
export function boltToWatts(bolt: number | string): bigint {
  // convert to string, handling scientific notation
  let boltStr: string;
  if (typeof bolt === 'string') {
    boltStr = bolt;
  } else {
    // handle very small numbers that might be in scientific notation
    if (bolt < 0.0001 && bolt > 0) {
      // use toFixed to avoid scientific notation
      boltStr = bolt.toFixed(8);
    } else {
      boltStr = bolt.toString();
    }
  }
  
  // handle invalid input
  if (!boltStr || boltStr === 'NaN') {
    throw new Error(`Invalid BOLT amount: ${bolt}`);
  }
  
  // handle scientific notation in string form (e.g., "1e-8")
  if (boltStr.includes('e') || boltStr.includes('E')) {
    const num = parseFloat(boltStr);
    if (isNaN(num)) {
      throw new Error(`Invalid BOLT amount: ${bolt}`);
    }
    boltStr = num.toFixed(8);
  }
  
  // split into whole and decimal parts
  const parts = boltStr.split('.');
  const wholePart = parts[0] || '0';
  const decimalPart = parts[1] || '';
  
  // parse whole bolts
  let wholeBolts: bigint;
  try {
    wholeBolts = BigInt(wholePart);
  } catch (e) {
    throw new Error(`Invalid BOLT amount: ${bolt}`);
  }
  
  // parse fractional watts
  let fractionalWatts = 0n;
  if (decimalPart) {
    // pad or truncate to 8 decimal places
    const paddedDecimal = decimalPart.padEnd(8, '0').slice(0, 8);
    try {
      fractionalWatts = BigInt(paddedDecimal);
    } catch (e) {
      throw new Error(`Invalid BOLT amount: ${bolt}`);
    }
  }
  
  return wholeBolts * WATTS_PER_BOLT + fractionalWatts;
}

/**
 * parse a string amount that could be in BOLT or watts
 * @param amount string like "50 BOLT", "50", "1000 watts", "1000w"
 * @returns amount in watts
 */
export function parseAmount(amount: string): bigint {
  const trimmed = amount.trim().toLowerCase();
  
  // check for explicit watts
  if (trimmed.endsWith(' watts') || trimmed.endsWith(' watt')) {
    const num = trimmed.replace(/ watts?$/, '');
    return BigInt(num);
  }
  
  if (trimmed.endsWith('w')) {
    const num = trimmed.slice(0, -1);
    return BigInt(num);
  }
  
  // check for explicit BOLT
  if (trimmed.endsWith(' bolt')) {
    const num = trimmed.replace(/ bolt$/, '');
    return boltToWatts(num);
  }
  
  // assume BOLT if has decimal point, otherwise watts
  if (trimmed.includes('.')) {
    return boltToWatts(trimmed);
  }
  
  // for whole numbers, assume watts if small, BOLT if large
  const num = BigInt(trimmed);
  if (num <= 100n) {
    // probably meant BOLT (who sends 100 watts?)
    return num * WATTS_PER_BOLT;
  }
  
  return num; // assume watts
}

/**
 * format a transaction fee in watts for display
 * @param feeInWatts fee amount in watts
 * @param bytesSize transaction size in bytes
 * @returns formatted string like "1000 watts (4 watts/byte)"
 */
export function formatFee(feeInWatts: bigint, bytesSize?: number): string {
  const base = formatWatts(feeInWatts);
  
  if (bytesSize && bytesSize > 0) {
    const feePerByte = feeInWatts / BigInt(bytesSize);
    return `${base} (${feePerByte} watts/byte)`;
  }
  
  return base;
}