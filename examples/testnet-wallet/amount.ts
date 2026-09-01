export function parseAmount(value: string): bigint {
  if (/^(?:0|[1-9]\d*)w$/.test(value)) return BigInt(value.slice(0, -1));
  const match = value.match(/^(0|[1-9]\d*)(?:\.(\d{1,8}))?$/);
  if (!match) throw new Error('Amount must be decimal BOLT or integer watts with w suffix');
  return BigInt(match[1]) * 100_000_000n + BigInt((match[2] || '').padEnd(8, '0'));
}
