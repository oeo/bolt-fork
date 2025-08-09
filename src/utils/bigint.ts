/**
 * Utility functions for BigInt JSON serialization/deserialization
 */

// Convert BigInt to string with suffix
export const bigIntReplacer = (key: string, value: any) =>
  typeof value === 'bigint' ? value.toString() + 'n' : value;

export const bigIntReviver = (key: string, value: any) => {
  if (typeof value === 'string' && /^\d+n$/.test(value)) {
    return BigInt(value.slice(0, -1));
  }
  return value;
};

/**
 * Serialize object with BigInt support
 */
export function serialize(obj: any): string {
  return JSON.stringify(obj, bigIntReplacer);
}

/**
 * Deserialize JSON with BigInt support
 */
export function deserialize(json: string): any {
  return JSON.parse(json, bigIntReviver);
}