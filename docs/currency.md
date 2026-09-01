# bolt currency system

## currency units

bolt uses a two-tier denomination system:

- **BOLT** - The main currency unit (like BTC in Bitcoin)
- **watt** - The smallest indivisible unit (like satoshi in Bitcoin)

### conversion

- 1 BOLT = 100,000,000 watts (10^8)
- 1 watt = 0.00000001 BOLT
- Precision: 8 decimal places

### why "watts"?

The term "watts" was chosen to:
1. Differentiate bolt from Bitcoin (which uses satoshis)
2. Fit the electrical/energy theme (bolt = lightning, watts = electrical power)
3. Create a memorable and unique identity for the currency

## internal representation

All amounts are stored internally as `bigint` values in watts:

```typescript
// 1 BOLT represented internally
const oneBolt = 100_000_000n; // watts

// 0.5 BOLT represented internally
const halfBolt = 50_000_000n; // watts

// Transaction fee of 1000 watts
const fee = 1000n;
```

## configuration

Currency fundamentals are defined as protocol constants in `src/constants.ts`:

```typescript
export const WATTS_PER_BOLT = 100_000_000n;
export const CURRENCY_DECIMALS = 8;
```

Economic parameters are configured per network in `src/config/chains/`:

```typescript
// Example from mainnet.ts
export const mainnet: ChainConfig = {
  maxSupply: 21_000_000n * 100_000_000n,  // 21M BOLT in watts
  initialReward: 50n * 100_000_000n,      // 50 BOLT in watts
  halvingInterval: 210000,                // blocks between halvings
  minFeePerByte: 1n,                       // 1 watt per byte
  // ... other parameters
};
```

## utility functions

The `src/utils/currency.ts` module provides conversion utilities:

```typescript
// Convert watts to BOLT display string
wattsToBolt(5_000_000_000n) // "50 BOLT"

// Convert BOLT to watts
boltToWatts(50) // 5000000000n

// Smart formatting
formatWatts(100n) // "100 watts"
formatWatts(100_000_000n) // "1 BOLT"

// Parse user input
parseAmount("50 BOLT") // 5000000000n
parseAmount("1000 watts") // 1000n
```

## transaction fees

- Minimum fee: 1 watt per byte
- Fees are calculated in watts
- Example: 250-byte transaction = minimum 250 watts

## economic parameters

Economic parameters vary by network:

### mainnet
- **Initial block reward**: 50 BOLT (5,000,000,000 watts)
- **Halving interval**: Every 210,000 blocks
- **Maximum supply**: 21,000,000 BOLT (2.1 quadrillion watts)
- **Block time target**: 5 minutes (300 seconds)
- **startup**: disabled until launch difficulty is selected

### testnet
- **Initial block reward**: 50 BOLT
- **Halving interval**: Every 10,000 blocks (faster for testing)
- **Maximum supply**: 21,000,000 BOLT
- **Block time target**: 1 minute (60 seconds)

### devnet
- **Initial block reward**: 1000 BOLT (for easy testing)
- **Halving interval**: Every 1,000 blocks
- **Maximum supply**: 21,000,000 BOLT
- **Block time target**: 10 seconds

## network selection

Select the network via the `BOLT_NETWORK` environment variable:

```bash
BOLT_NETWORK=mainnet  # Production network (default)
BOLT_NETWORK=testnet  # Test network
BOLT_NETWORK=devnet   # Local development
```

genesis issues no currency. block reward accounting excludes genesis and the target height when calculating prior issuance. rewards stop at zero or maximum supply.
