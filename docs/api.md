# bolt rest api documentation

## overview

the bolt rest api provides http/json endpoints for interacting with the blockchain, submitting transactions, and monitoring network status. the api server runs on port 7333 by default.

## base url

```
http://localhost:7333
```

## authentication

currently, the api does not require authentication. future versions may add api key support.

## endpoints

### health & monitoring

#### GET /health

health check endpoint

**response:**
```json
{
  "status": "ok",
  "timestamp": 1691615999000
}
```

### blockchain

#### GET /blockchain/info

get blockchain statistics and configuration

**response:**
```json
{
  "network": "testnet",
  "height": 1000,
  "latestBlockHash": "abc123...",
  "difficulty": 15,
  "cumulativeDifficulty": "999999",
  "targetBlockTime": 300,
  "difficultyAdjustmentInterval": 2016,
  "maxSupply": "21000000 BOLT",
  "currentReward": "50 BOLT"
}
```

#### GET /blocks

get paginated list of blocks (newest first)

**query parameters:**
- `limit` (number, default: 10) - number of blocks to return
- `offset` (number, default: 0) - pagination offset

**response:**
```json
{
  "blocks": [
    {
      "index": 1000,
      "hash": "def456...",
      "previousHash": "abc123...",
      "timestamp": 1691615999000,
      "difficulty": 15,
      "nonce": 12345,
      "merkleRoot": "ghi789...",
      "transactions": [...],
    }
  ],
  "total": 1001,
  "limit": 10,
  "offset": 0
}
```

#### GET /blocks/:hashOrHeight

get specific block by hash or height

**parameters:**
- `hashOrHeight` - block hash (hex) or height (number)

**response:**
```json
{
  "index": 100,
  "hash": "abc123...",
  "previousHash": "xyz789...",
  "timestamp": 1691615999000,
  "difficulty": 10,
  "nonce": 54321,
  "merkleRoot": "def456...",
  "transactions": [...],
}
```

**errors:**
- `500` - block not found

### transactions

#### POST /transactions

submit a signed transaction

**request body:**
```json
{
  "chainId": 1058,
  "kind": "transfer",
  "hash": "tx123...",
  "from": "B1abc...",
  "to": "B1def...",
  "amount": "100000000000",  // in watts (1000 BOLT)
  "fee": "1000000",          // in watts (0.01 BOLT)
  "nonce": 0,
  "timestamp": 1691615999000,
  "signature": "sig123...",
  "publicKey": "pub123..."
}
```

**validation:**
- requires the configured chain id
- requires sender and recipient addresses from the configured chain
- verifies sender has sufficient balance (amount + fee)
- checks nonce matches expected value
- validates transaction signature
- ensures fee meets minimum requirements

**response:**
```json
{
  "hash": "tx123...",
  "accepted": true,
  "broadcasted": true  // false if no p2p node
}
```

**errors:**
- `500` - invalid transaction:
  - insufficient balance
  - invalid nonce
  - invalid signature
  - fee too low

#### GET /transactions/:hash

get transaction by hash

**response:**
```json
{
  "hash": "tx123...",
  "from": "B1abc...",
  "to": "B1def...",
  "amount": "100000000000",
  "fee": "1000000",
  "nonce": 0,
  "timestamp": 1691615999000,
  "signature": "sig123...",
  "status": "confirmed",  // or "pending"
  "confirmations": 6,
  "blockHeight": 995
}
```

**errors:**
- `500` - transaction not found

### accounts

#### GET /accounts/:address/balance

get account balance in watts

**response:**
```json
{
  "address": "B1abc...",
  "balance": "500000000000",  // in watts
  "formatted": "5000 BOLT"    // human-readable
}
```

#### GET /accounts/:address/nonce

get account nonce (for transaction ordering)

**response:**
```json
{
  "address": "B1abc...",
  "nonce": 5
}
```

### mempool

#### GET /mempool

get mempool statistics

**response:**
```json
{
  "size": 25,                    // number of transactions
  "bytes": 12500,                // total size in bytes
  "minFeePerByte": "1",          // minimum fee in watts
  "maxFeePerByte": "1000",       // maximum fee in watts
  "averageFeePerByte": "50",     // average fee in watts
  "totalFees": "250000 watts"    // total fees formatted
}
```

#### GET /mempool/transactions

get all mempool transactions

**response:**
```json
{
  "transactions": [
    {
      "chainId": 1058,
      "kind": "transfer",
      "hash": "tx123...",
      "from": "B1abc...",
      "to": "B1def...",
      "amount": "100000000000",
      "fee": "1000000",
      "nonce": 0,
      "timestamp": 1691615999000
    }
  ],
  "count": 25
}
```

### network

#### GET /network/status

get p2p network status

**response:**
```json
{
  "peerId": "QmAbc123...",
  "multiaddrs": [
    "/ip4/0.0.0.0/tcp/7334/p2p/QmAbc123..."
  ],
  "connectedPeers": 8,
  "protocols": [
    "/bolt/version/1.0.0",
    "/bolt/sync/blocks/1.0.0"
  ],
  "topics": [
    "/bolt/blocks/1.0.0",
    "/bolt/transactions/1.0.0"
  ],
  "blockHeight": 1000,
  "syncing": false
}
```

**note:** returns error if p2p node not available

#### GET /peers

list connected peers

**response:**
```json
{
  "peers": [
    "QmDef456...",
    "QmGhi789..."
  ],
  "count": 2
}
```

#### POST /peers/connect

manually connect to a peer

**request body:**
```json
{
  "address": "/ip4/192.168.1.100/tcp/7334/p2p/QmXyz..."
}
```

**response:**
```json
{
  "connected": true,
  "address": "/ip4/192.168.1.100/tcp/7334/p2p/QmXyz..."
}
```

**errors:**
- `500` - connection failed or p2p node not available

## error responses

all errors return appropriate http status codes with json error messages:

```json
{
  "error": "Description of the error"
}
```

common status codes:
- `200` - success
- `204` - no content (options requests)
- `404` - endpoint not found
- `500` - internal server error

## cors support

the api includes cors headers for browser compatibility:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

## bigint handling

large numbers (balances, fees, cumulative difficulty) are serialized as strings with an 'n' suffix for bigint values:

```json
{
  "balance": "100000000000n",
  "cumulativeDifficulty": "999999999n"
}
```

the api uses the custom bigint serializer from `src/utils/bigint.ts`.

## configuration

api settings via environment variables:

```bash
API_PORT=7333     # api server port (default: 7333)
```

## rate limiting

currently no rate limiting. future versions may add:
- request rate limiting per ip
- transaction submission limits
- expensive query throttling

## websocket support (phase 3)

future websocket endpoints for real-time updates:
- block notifications
- transaction confirmations
- mempool updates
- peer events

## examples

### submit a transaction

```bash
curl -X POST http://localhost:7333/transactions \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 1058,
    "kind": "transfer",
    "hash": "abc123...",
    "from": "B1sender...",
    "to": "B1receiver...",
    "amount": "100000000000",
    "fee": "1000000",
    "nonce": 0,
    "timestamp": 1691615999000,
    "signature": "sig...",
    "publicKey": "pub..."
  }'
```

### check balance

```bash
curl http://localhost:7333/accounts/B1abc.../balance
```

### get latest blocks

```bash
curl http://localhost:7333/blocks?limit=5
```

### connect to peer

```bash
curl -X POST http://localhost:7333/peers/connect \
  -H "Content-Type: application/json" \
  -d '{"address": "/ip4/192.168.1.100/tcp/7334/p2p/QmXyz..."}'
```
