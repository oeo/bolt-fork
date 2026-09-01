# bolt rest api

## exposure

public routes have no authentication, authorization, cors policy, or rate limiting. node startup binds to `127.0.0.1` by default. `API_HOST` changes the bind host. expose public routes only through a trusted authenticated gateway.

compose binds the process to `0.0.0.0` inside the container and publishes port `7333` to host loopback. block and transaction exchange between nodes uses authenticated tcp protocol messages. network-control routes are not implemented. mining routes remain disabled unless explicitly configured.

## configuration

```bash
API_HOST=127.0.0.1
API_PORT=7333
MINING_API_ENABLED=false
MINING_API_TOKEN=
```

request bodies are limited to 128 KiB. collection pages allow 1 through 100 items and default to `limit=10&offset=0`. block and mempool transaction pages stop before their encoded entries exceed 16 MiB.

## response behavior

| status | behavior |
|---|---|
| `200` | request completed |
| `400` | invalid body, identifier, address, or pagination |
| `404` | endpoint or resource not found |
| `405` | method not allowed |
| `413` | request body exceeds Bun server limit |
| `415` | transaction submission is not `application/json` |
| `500` | internal error with a bounded public message |

responses do not include wildcard cors headers. pagination routes return `400` for unknown or duplicate query parameters.

## active routes

### health and blockchain

| method | path | behavior |
|---|---|---|
| `GET` | `/health` | returns `status: "ok"` and current millisecond timestamp |
| `GET` | `/blockchain/info` | returns network, height, tip hash, difficulty, cumulative difficulty, timing configuration, formatted maximum supply, and formatted current reward |
| `GET` | `/blocks` | returns blocks newest first with `total`, `limit`, `offset`, and `count` |
| `GET` | `/blocks/:hashOrHeight` | reads a non-negative decimal height or 64-character lowercase hexadecimal hash |

### transactions, accounts, and mempool

| method | path | behavior |
|---|---|---|
| `POST` | `/transactions` | deserializes a transaction, submits it to mempool admission, and returns `hash` and `accepted` |
| `GET` | `/transactions/:hash` | checks the mempool first, then one canonical storage snapshot; returns pending or confirmed status |
| `GET` | `/accounts/:address/balance` | validates the active network prefix and returns raw and formatted balance |
| `GET` | `/accounts/:address/nonce` | validates the active network prefix and returns account nonce |
| `GET` | `/mempool` | returns size, bytes, fee-per-byte values, and formatted total fees |
| `GET` | `/mempool/transactions` | returns a bounded page with `total`, `limit`, `offset`, and `count` |

confirmed transaction responses calculate confirmations from the block location and canonical height read by the same storage operation. transaction submission does not report network broadcast state.

### mining

| method | path | behavior |
|---|---|---|
| `POST` | `/mining/template` | returns payout-specific bounded in-memory proof-of-work job |
| `POST` | `/mining/submit` | validates bounded submission against retained job |

mining routes require `MINING_API_ENABLED=true`, non-empty `MINING_API_TOKEN`, and bearer authorization. disabled routes return `404`. request concurrency, submission rate, body size, job count, identifiers, and numeric fields are bounded.

template version 1 exposes the exact target and fixed header fields required for sha-256 nonce solving. [getblocktemplate](getblocktemplate.md) defines the language-neutral preimage and fixed vector.

## bigint encoding

raw bigint values are json strings with an `n` suffix. request bodies use the same representation when a field must deserialize to bigint.

```json
{
  "balance": "100000000000n",
  "fee": "1000000n",
  "cumulativeDifficulty": "999999999n"
}
```

formatted currency fields remain ordinary strings. encoding and decoding use `src/utils/bigint.ts`.
