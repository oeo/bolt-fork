# bolt rest api

## exposure

the api has no authentication or authorization. current node startup binds it to `0.0.0.0`, and every response permits wildcard cors. run it only on a trusted network or behind an authenticated gateway.

`POST /peers/connect`, `POST /peer/blocks`, and `POST /peer/transactions` are unauthenticated peer mutation routes. they can initiate outbound connections or submit data for chain and mempool processing. exposing them to an untrusted network is a security risk.

no rate limiting is implemented. no mining http endpoints are implemented.

## configuration

the default address is `http://0.0.0.0:7333`. `API_PORT` changes the port. `ApiServerConfig.host` can change the bind host when the server is constructed programmatically.

```bash
API_PORT=7333
```

## response behavior

route dispatch uses these generic statuses:

| status | behavior |
|---|---|
| `200` | any handled non-options route whose handler returns, including returned objects with `error` or `success: false` |
| `204` | every `OPTIONS` request, with no response body |
| `404` | unknown path or unsupported method, with `{"error":"Endpoint not found"}` |
| `500` | uncaught handler or parsing error, with `{"error":"<message>"}` or `{"error":"Internal server error"}` |

all routes receive these cors headers:

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

## active routes

### health and blockchain

| method | path | behavior |
|---|---|---|
| `GET` | `/health` | returns `status: "ok"` and current millisecond timestamp |
| `GET` | `/blockchain/info` | returns network, height, tip hash, difficulty, cumulative difficulty, timing configuration, formatted maximum supply, and formatted current reward |
| `GET` | `/blocks` | returns blocks newest first with `total`, `limit`, and `offset`; defaults are `limit=10` and `offset=0` |
| `GET` | `/blocks/:hashOrHeight` | reads a decimal height or otherwise treats the parameter as a hash; missing blocks raise `500` |

### transactions, accounts, and mempool

| method | path | behavior |
|---|---|---|
| `POST` | `/transactions` | deserializes and validates a transaction, adds it to the mempool, and returns `hash`, `accepted`, and `broadcasted` |
| `GET` | `/transactions/:hash` | checks the mempool first, then stored transactions; returns pending or confirmed status |
| `GET` | `/accounts/:address/balance` | returns raw balance and formatted balance |
| `GET` | `/accounts/:address/nonce` | returns account nonce |
| `GET` | `/mempool` | returns size, bytes, fee-per-byte values, and formatted total fees |
| `GET` | `/mempool/transactions` | returns all mempool transactions and their count |

### network

| method | path | behavior |
|---|---|---|
| `GET` | `/network/status` | returns node and chain status when a node is injected |
| `GET` | `/peers` | returns connected peers when a node is injected |
| `POST` | `/peers/connect` | deserializes `{ "address": "<multiaddr>" }` and asks the injected node to connect |

current startup in `src/index.ts` does not inject a node into `ApiServer`. network routes therefore behave as follows:

| route | current result |
|---|---|
| `GET /network/status` | `200` with `{"error":"Network node not available"}` |
| `GET /peers` | `200` with `{"error":"Network node not available"}` |
| `POST /peers/connect` | `500` with `{"error":"Network node not available"}` |

transaction submission also reports `broadcasted: false` in current startup.

### peer synchronization

| method | path | behavior |
|---|---|---|
| `GET` | `/peer/status` | returns node id, chain height, tip hash, role capability, and timestamp |
| `GET` | `/peer/blocks?height=:height` | returns sequential blocks from `height`, defaulting to `0` and limiting the result to 100 blocks |
| `POST` | `/peer/blocks` | deserializes one block and attempts chain insertion, sync deferral, or competing-chain handling |
| `GET` | `/peer/transactions` | returns all mempool transactions |
| `POST` | `/peer/transactions` | deserializes one transaction and attempts mempool insertion |

peer block and transaction handlers catch processing failures and return `200` with `success: false` and an `error` value.

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
