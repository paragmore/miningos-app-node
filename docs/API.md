## API Reference

### Base URL

```
http://localhost:3000
```

All authenticated endpoints require the `Authorization` header:

```bash
curl -H "Authorization:Bearer YOUR_TOKEN_HERE" http://localhost:3000/auth/userinfo
```

### `timezone` Query Parameter

`timezone` (an IANA zone, e.g. `America/Sao_Paulo`) only sets how day/month buckets are cut. It never changes how `start`/`end` are read: those are always UTC ms timestamps. When omitted, the site zone (`featureConfig.lockedTimezone`, default `America/Campo_Grande`) is used.

It is honored on:

- `/auth/finance/*`
- `/auth/metrics/downtime`
- `/auth/pools/:pool/balance-history`
- `/auth/metrics/hashrate`, only for the calendar-month rollup (`interval=1M` with no `groupBy` and no rack filter)
- `/auth/export`, for date labels and invoicing buckets (defaults to `UTC` here, not the site zone)

These routes reject it with `400 ERR_TIMEZONE_UNSUPPORTED`:

- `/auth/metrics/hashrate` (any request other than the 1M rollup above)
- `/auth/metrics/consumption`, `/auth/metrics/efficiency`, `/auth/metrics/miner-status`, `/auth/metrics/pool-hashrate`
- `/auth/metrics/revenue/hourly`, `/auth/metrics/power-mode`, `/auth/metrics/power-mode/timeline`
- `/auth/metrics/temperature`, `/auth/metrics/cooling`, `/auth/metrics/containers/:id/history`
- `/auth/tail-log`, `/auth/tail-log/multi`, `/auth/history-log`
- `/auth/site/power-consumption`, `/auth/energy/forecast/history`
- `/auth/alerts/history`, `/auth/work-orders/:id/audit`

```json
{ "statusCode": 400, "error": "Bad Request", "message": "ERR_TIMEZONE_UNSUPPORTED" }
```

Other routes don't use it and ignore it.

### Authentication Endpoints

#### `GET /oauth/google/callback`

**Google OAuth2 callback handler** (auto-redirect from Google)

**Response:** Redirects to UI with `?authToken=...` or `?error=...`

---

#### `GET /auth/userinfo`

**Get current user information**

**Auth Required:** Yes  
**Permissions:** None (only authenticated user)

**Response:**
```json
{
  "userId": 5,
  "email": "user@company.com",
  "roles": ["site_operator"],
  "created": 1672531200,
  "ttl": 1672531200
}
```

---

#### `POST /auth/token`

**Regenerate authentication token**

**Auth Required:** Yes  
**Permissions:** None

**Request Body:**
```json
{
  "ips": ["192.168.1.100"],
  "ttl": 7200,
  "pfx": "pub",
  "scope": "api",
  "roles": ["site_operator"]
}
```

**Response:**
```json
{
  "token": "new_token_here"
}
```

---

#### `GET /auth/permissions`

**Get current user's permissions**

**Auth Required:** Yes

**Response:**
```json
{
  "permissions": {
    "write": true,
    "caps": ["miner", "container", "actions"],
    "superAdmin": false,
    "permissions": [
      "miner:r", "miner:w",
      "container:r", "container:w",
      "actions:r", "actions:w"
    ]
  }
}
```

---

#### `GET /auth/site`

**Get current site name**

**Auth Required:** Yes

**Response:**
```json
{
  "site": "production-site-01"
}
```

---

#### `GET /auth/ext-data`

**Get extended worker data from ORKs**

**Auth Required:** Yes  
**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | Yes | Data type to query |
| `query` | JSON string | No | MongoDB-style query filter |
| `overwriteCache` | boolean | No | Bypass cache |

**Example:**
```bash
curl -H "Authorization:Bearer TOKEN" \
  "http://localhost:3000/auth/ext-data?type=miner&query=%7B%22status%22%3A%22online%22%7D"
```

---

### User Management Endpoints

#### `POST /auth/users`

**Create a new user**

**Auth Required:** Yes  
**Permissions:** `users:w`

**Request Body:**
```json
{
  "data": {
    "email": "newuser@company.com",
    "role": "dev"
  }
}
```

**Response:**
```json
{
  "success": true
}
```

**Notes:**
- Super admin can create users of any role
- Admin can create: site_operator, dev, read_only_user
- Audit log entry created

---

#### `GET /auth/users`

**List all users** (filtered by role management permissions)

**Auth Required:** Yes  
**Permissions:** `users:w`

**Response:**
```json
{
  "users": [
    {
      "id": 2,
      "email": "operator@company.com",
      "role": "site_operator"
    },
    {
      "id": 3,
      "email": "viewer@company.com",
      "role": "read_only_user"
    }
  ]
}
```

**Notes:**
- Super admin sees all users (except super admin itself)
- Admin sees only users they can manage
- Super admin user (ID=1) is never returned

---

#### `PUT /auth/users`

**Update user details**

**Auth Required:** Yes  
**Permissions:** `users:w`

**Request Body:**
```json
{
  "data": {
    "id": 3,
    "email": "viewer@company.com",
    "role": "dev"
  }
}
```

**Response:**
```json
{
  "success": true
}
```

**Restrictions:**
- Cannot update super admin (ID=1)
- Can only update users you have permission to manage
- Audit log entry created

---

#### `POST /auth/users/delete`

**Delete a user**

**Auth Required:** Yes  
**Permissions:** `users:w`

**Request Body:**
```json
{
  "data": {
    "id": 3
  }
}
```

**Response:**
```json
{
  "success": true
}
```

**Restrictions:**
- Cannot delete yourself
- Cannot delete super admin
- Can only delete users you have permission to manage
- Audit log entry created

---

### Global Data Endpoints

#### `GET /auth/global/data`

**Query global data** (production costs, container settings, site energy, features)

**Auth Required:** Yes  
**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | Yes | `productionCosts`, `containerSettings`, `siteEnergy`, `features` |
| `gt` | integer | No | Greater than (range query) |
| `gte` | integer | No | Greater than or equal |
| `lt` | integer | No | Less than |
| `lte` | integer | No | Less than or equal |
| `limit` | integer | No | Maximum results |
| `query` | JSON string | No | MongoDB-style query |
| `fields` | JSON string | No | Field projection |
| `sort` | JSON string | No | Sort specification |
| `offset` | integer | No | Pagination offset |
| `groupBy` | string | No | Group results by field |
| `overwriteCache` | boolean | No | Bypass cache |

**Example (Container Settings):**
```bash
curl -H "Authorization:Bearer TOKEN" \
  "http://localhost:3000/auth/global/data?type=containerSettings&query=%7B%22site%22%3A%22site-01%22%7D"
```

**Response:**
```json
[
  {
    "site": "site-01",
    "model": "MicroBT-D40",
    "parameters": {
      "runningSpeed": 100,
      "startTemp": 25,
      "stopTemp": 85,
      "coolOilSetTemp": 40,
      "coolOilAlarmTemp": 75,
      "coolWaterAlarmTemp": 45
    },
    "thresholds": {
      "waterTemperature": {
        "criticalLow": 10,
        "alarmLow": 20,
        "normal": 35,
        "alarmHigh": 45,
        "criticalHigh": 50
      },
      "oilTemperature": {
        "criticalLow": 15,
        "alert": 30,
        "normal": 40,
        "alarm": 75,
        "criticalHigh": 85
      }
    }
  }
]
```

**Example (Production Costs):**
```bash
curl -H "Authorization:Bearer TOKEN" \
  "http://localhost:3000/auth/global/data?type=productionCosts&gte=202401&lte=202412"
```

**Response:**
```json
[
  {
    "site": "site-01",
    "year": 2024,
    "month": 10,
    "energyCostsUSD": 1000.00,
    "operationalCostsUSD": 1000.00
  }
]
```

---

#### `POST /auth/global/data`

**Set global data**

**Auth Required:** Yes  
**Permissions:** `features:w`  
**Query Parameters:** `type` (required)

**Request Body (Production Costs):**
```json
{
  "data": {
    "site": "site-01",
    "year": 2024,
    "month": 10,
    "energyCostsUSD": 1000.00,
    "operationalCostsUSD": 1000.00
  }
}
```

**Request Body (Site Energy):**
```json
{
  "data": {
    "site": "site-01",
    "energyExclusionThresholdMwh": 100.5
  }
}
```

**Request Body (Container Settings):**
```json
{
  "data": {
    "site": "site-01",
    "model": "MicroBT-D40",
    "parameters": {
      "runningSpeed": 100,
      "startTemp": 25,
      "stopTemp": 85,
      "coolOilAlarmTemp": 75,
      "coolWaterAlarmTemp": 45,
      "coolOilSetTemp": 40,
      "hotOilAlarmTemp": 80,
      "hotWaterAlarmTemp": 50,
      "exhaustFansRunTemp": 60,
      "alarmPressure": 150,
      "miner1CoolingConsumptionW": 500,
      "miner1MinPowerW": 3000,
      "miner2CoolingConsumptionW": 500,
      "miner2MinPowerW": 3000
    },
    "thresholds": {
      "waterTemperature": {
        "criticalLow": 10,
        "alarmLow": 20,
        "normal": 35,
        "alarmHigh": 45,
        "criticalHigh": 50
      },
      "oilTemperature": {
        "criticalLow": 15,
        "alert": 30,
        "normal": 40,
        "alarm": 75,
        "criticalHigh": 85
      },
      "tankPressure": {
        "criticalLow": 50,
        "alarmLow": 80,
        "normal": 100,
        "alarmHigh": 140,
        "criticalHigh": 160
      },
      "supplyLiquidPressure": {
        "criticalLow": 60,
        "alarmLow": 90,
        "normal": 110,
        "alarmHigh": 150,
        "criticalHigh": 170
      }
    }
  }
}
```

**Response:**
```json
{
  "success": true
}
```

---

#### `GET /auth/featureConfig`

**Get static feature configuration** (from config)

**Auth Required:** Yes

**Response:**
```json
{
  "comments": true,
  "inventory": false,
  "lvCabinetWidgets": true,
  "poolStats": true,
  "powerAvailable": true,
  "reporting": true,
  "settings": true,
  "isOneMinItvEnabled": false,
  "powerModeTimeline": false,
  "totalSystemConsumptionChart": false,
  "exportHistKpiDashboard": false,
  "showMinerConsumptionDashboard": false,
  "totalSystemConsumptionHeader": false,
  "energyProvision": true
}
```

---

#### `GET /auth/features`

**Get dynamic feature flags** (from storage)

**Auth Required:** Yes

**Response:**
```json
{
  "experimentalDashboard": true,
  "advancedMetrics": false,
  "autoScaling": true
}
```

---

#### `POST /auth/features`

**Set feature flags**

**Auth Required:** Yes  
**Permissions:** `features:w`

**Request Body:**
```json
{
  "data": {
    "experimentalDashboard": true,
    "advancedMetrics": true,
    "autoScaling": false
  }
}
```

**Response:**
```json
{
  "success": true
}
```

---

#### `GET /auth/global-config`

**Get global configuration from all ORKs**

**Auth Required:** Yes  
**Query Parameters:** `fields` (optional JSON projection), `overwriteCache`

**Response:**
```json
[
  {
    "isAutoSleepAllowed": true
  },
  {
    "isAutoSleepAllowed": false
  }
]
```

---

#### `POST /auth/global-config`

**Set global configuration on all ORKs**

**Auth Required:** Yes  
**Permissions:** `features:w`

**Request Body:**
```json
{
  "data": {
    "isAutoSleepAllowed": false
  }
}
```

**Response:**
```json
[
  { "success": true },
  { "success": true }
]
```

---

### Things Management Endpoints

#### `GET /auth/list-things`

**List all things** (miners, containers, sensors)

**Auth Required:** Yes  
**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | JSON string | MongoDB-style query filter |
| `status` | string | Filter by status |
| `offset` | integer | Pagination offset |
| `limit` | integer | Results per page |
| `fields` | JSON string | Field projection |
| `sort` | JSON string | Sort specification |
| `overwriteCache` | boolean | Bypass cache |

**Example:**
```bash
curl -H "Authorization:Bearer TOKEN" \
  "http://localhost:3000/auth/list-things?query=%7B%22status%22%3A%22online%22%7D&limit=50"
```

**Response:**
```json
[
  [
    {
      "id": "miner-01",
      "type": "miner",
      "status": "online",
      "hashrate": 110000000000000,
      "temperature": 65,
      "power": 3250
    },
    {
      "id": "container-01",
      "type": "container",
      "status": "online",
      "oilTemp": 42,
      "waterTemp": 38
    }
  ]
]
```

---

#### `GET /auth/list-racks`

**List racks by type**

**Auth Required:** Yes  
**Query Parameters:** `type` (required, e.g., "miner", "container"), `overwriteCache`

**Example:**
```bash
curl -H "Authorization:Bearer TOKEN" \
  "http://localhost:3000/auth/list-racks?type=miner"
```

**Response:**
```json
[
  [
    "rack-01",
    "rack-02",
    "rack-03"
  ]
]
```

---


#### `GET /auth/settings`

**Get thing settings**

**Auth Required:** Yes  
**Query Parameters:** `rackId` (required)

**Response:**
```json
[
  {
    "success": {
      "rackId": "rack-01",
      "entries": {
        "targetTemp": 65,
        "fanSpeed": 80,
        "powerLimit": 3500
      }
    }
  }
]
```

---

#### `PUT /auth/settings`

**Save thing settings**

**Auth Required:** Yes  
**Permissions:** Write required

**Request Body:**
```json
{
  "rackId": "rack-01",
  "entries": {
    "targetTemp": 70,
    "fanSpeed": 85,
    "powerLimit": 3400
  }
}
```

**Response:**
```json
[
  { "success": true }
]
```

---

#### `POST /auth/thing/comment`

**Add comment to a thing**

**Auth Required:** Yes  
**Permissions:** `comments:w`

**Request Body:**
```json
{
  "rackId": "rack-01",
  "thingId": "miner-01",
  "comment": "Replaced thermal paste and cleaned fans"
}
```

**Response:**
```json
[
  { "success": true }
]
```

---

#### `PUT /auth/thing/comment`

**Edit existing comment**

**Auth Required:** Yes  
**Permissions:** `comments:w`

**Request Body:**
```json
{
  "rackId": "rack-01",    // Required
  "thingId": "miner-01",  // Required
  "comment": "Updated comment text",  // Required
  "id": "comment-123",    // Optional (but recommended for identification)
  "ts": 1672531200000     // Optional
}
```
**Note:** While `id` and `ts` are not schema-required, providing them helps identify which comment to update.

---

#### `DELETE /auth/thing/comment`

**Delete comment**

**Auth Required:** Yes  
**Permissions:** `comments:w`

**Request Body:**
```json
{
  "rackId": "rack-01",    // Required
  "thingId": "miner-01",  // Required
  "id": "comment-123",    // Optional (but recommended for identification)
  "ts": 1672531200000     // Optional
}
```
**Note:** While `id` and `ts` are not schema-required, providing them helps identify which comment to delete.

---

#### `GET /auth/worker-config`

**Get worker configuration from ORKs**

**Auth Required:** Yes  
**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | Yes | Worker type (e.g., "miner") |
| `fields` | JSON string | No | Field projection |
| `overwriteCache` | boolean | No | Bypass cache |

**Example:**
```bash
curl -H "Authorization:Bearer TOKEN" \
  "http://localhost:3000/auth/worker-config?type=miner"
```

**Response:**
```json
[
  {
    "type": "miner",
    "config": {
      "pollingInterval": 5000,
      "healthCheckTimeout": 3000,
      "maxRetries": 3
    }
  }
]
```

---

#### `GET /auth/thing-config`

**Get thing configuration from ORKs**

**Auth Required:** Yes  
**Query Parameters:** `type` (required), `requestType` (required)

---

### Actions & Voting Endpoints

#### `GET /auth/actions`

**Query actions across all ORKs**

**Auth Required:** Yes  
**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `queries` | JSON string | Yes | Array of query objects |
| `groupBatch` | boolean | No | Group by batch UID |
| `overwriteCache` | boolean | No | Bypass cache |

**Example:**
```bash
curl -H "Authorization:Bearer TOKEN" \
  "http://localhost:3000/auth/actions?queries=%5B%7B%22status%22%3A%22pending%22%7D%5D"
```

**Response:**
```json
[
  {
    "actions": [
      {
        "id": 1,
        "type": "restart",
        "status": "pending",
        "voter": "operator@company.com",
        "created": 1672531200000
      }
    ]
  }
]
```

---

#### `GET /auth/actions/batch`

**Get multiple actions by IDs**

**Auth Required:** Yes  
**Query Parameters:** `ids` (comma-separated, required), `overwriteCache`

**Example:**
```bash
curl -H "Authorization:Bearer TOKEN" \
  "http://localhost:3000/auth/actions/batch?ids=1,2,3"
```

---

#### `GET /auth/actions/:type/:id`

**Get single action**

**Auth Required:** Yes  
**Path Parameters:** `type` (action type), `id` (action ID)

---

#### `POST /auth/actions/voting`

**Submit an action for approval**

**Auth Required:** Yes  
**Permissions:** Write required

**Request Body:**
```json
{
  "query": { "id": "miner-01" },
  "action": "restart",
  "params": ["graceful"]
}
```

**Response:**
```json
[
  {
    "id": 123,
    "errors": []
  }
]
```

**Notes:**
- Action includes voter email from authenticated user
- Permissions are passed to ORKs for validation

---

#### `POST /auth/actions/voting/batch`

**Submit batch of actions**

**Auth Required:** Yes  
**Permissions:** Write required

**Request Body:**
```json
{
  "batchActionsPayload": [
    {
      "query": { "id": "miner-01" },
      "action": "restart",
      "params": []
    },
    {
      "query": { "id": "miner-02" },
      "action": "restart",
      "params": []
    }
  ],
  "batchActionUID": "batch-123-uuid"
}
```

**Response:**
```json
[
  {
    "id": 124,
    "errors": []
  }
]
```

---


#### `PUT /auth/actions/voting/:id/vote`

**Vote on a pending action**

**Auth Required:** Yes  
**Permissions:** Write required

**Path Parameters:** `id` (action ID)

**Request Body:**
```json
{
  "approve": true
}
```

**Response:**
```json
[
  { "success": true }
]
```

---

#### `DELETE /auth/actions/voting/cancel`

**Cancel pending actions**

**Auth Required:** Yes  
**Permissions:** Write required  
**Query Parameters:** `ids` (comma-separated action IDs)

**Example:**
```bash
curl -X DELETE -H "Authorization:Bearer TOKEN" \
  "http://localhost:3000/auth/actions/voting/cancel?ids=1,2,3"
```

**Response:**
```json
[
  { "success": true }
]
```

---

### Logs & Monitoring Endpoints

#### `GET /auth/tail-log`

**Get real-time tail logs from ORKs**

**Auth Required:** Yes  
**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | Yes | Log key (e.g., "stat-5m", "stat-1h") |
| `type` | string | No | Thing type filter |
| `tag` | string | No | Tag filter |
| `start` | integer | No | Start timestamp (ms) |
| `end` | integer | No | End timestamp (ms) |
| `offset` | integer | No | Pagination offset |
| `limit` | integer | No | Results limit |
| `fields` | JSON string | No | Field projection |
| `aggrFields` | JSON string | No | Aggregation fields |
| `aggrTimes` | JSON array | No | Aggregation time windows |
| `mergeSitesData` | boolean | No | Merge data across sites |
| `applyAggrCrossthg` | boolean | No | Apply cross-thing aggregation |
| `overwriteCache` | boolean | No | Bypass cache |

**Example:**
```bash
curl -H "Authorization:Bearer TOKEN" \
  "http://localhost:3000/auth/tail-log?key=stat-5m&limit=100"
```

**Response:**
```json
[
  {
    "timestamp": 1672531200000,
    "thingId": "miner-01",
    "hashrate": 110000000000000,
    "temperature": 65,
    "power": 3250
  }
]
```

---

#### `GET /auth/tail-log/multi`

**Get tail logs for multiple keys**

**Auth Required:** Yes  
**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `keys` | JSON array | Yes | Array of log keys |
| Other params | - | No | Same as tail-log |

**Example:**
```bash
curl -H "Authorization:Bearer TOKEN" \
  "http://localhost:3000/auth/tail-log/multi?keys=%5B%22stat-5m%22%2C%22stat-1h%22%5D"
```

---

#### `GET /auth/tail-log/range-aggr`

**Get aggregated logs for custom time ranges**

**Auth Required:** Yes  
**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `keys` | JSON array | Yes | Array of query objects with type, startDate, endDate |
| `overwriteCache` | boolean | No | Bypass cache |

**Example:**
```bash
curl -H "Authorization:Bearer TOKEN" \
  "http://localhost:3000/auth/tail-log/range-aggr?keys=%5B%7B%22type%22%3A%22stat-5m%22%2C%22startDate%22%3A%221672531200000%22%2C%22endDate%22%3A%221672534800000%22%7D%5D"
```

---

#### `GET /auth/history-log`

**Get historical logs from ORKs**

**Auth Required:** Yes  
**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `logType` | string | Yes | "alerts" or "info" |
| `start` | integer | No | Start timestamp (ms) |
| `end` | integer | No | End timestamp (ms) |
| `startExcl` | integer | No | Start exclusive timestamp |
| `endExcl` | integer | No | End exclusive timestamp |
| `offset` | integer | No | Pagination offset |
| `limit` | integer | No | Results limit |
| `tag` | string | No | Tag filter |
| `query` | JSON string | No | MongoDB-style query |
| `fields` | JSON string | No | Field projection |
| `overwriteCache` | boolean | No | Bypass cache |

**Example (Alerts):**
```bash
curl -H "Authorization:Bearer TOKEN" \
  "http://localhost:3000/auth/history-log?logType=alerts&start=1672531200000&end=1672617600000"
```

**Response:**
```json
[
  {
    "timestamp": 1672531200000,
    "level": "warning",
    "thingId": "miner-01",
    "message": "Temperature threshold exceeded",
    "details": {
      "temperature": 85,
      "threshold": 80
    }
  }
]
```

---

### Site Phases (per-phase metrics)

A deployment can split its reporting into phases via `featureConfig.phases` in `config/common.json` — a list of `{ id, label, pool.accounts[], consumption.{source,logType,meterKey}, minerTelemetry, groups.{minerType,container} }`. The `total` id is reserved and means "no filtering". Without the key, nothing changes anywhere.

With phases configured:

- `phase=<id>` is accepted by `GET /auth/metrics/hashrate`, `GET /auth/metrics/pool-hashrate`, `GET /auth/metrics/efficiency` and `GET /auth/finance/revenue-summary`. `phase=total` equals omitting it; an unknown id (or any value on an unconfigured site) is `400 ERR_PHASE_INVALID`.
- A phase with `minerTelemetry: false` has no MOS miners: its hashrate is bucketed from its own pool accounts' `hashrate-history` samples, `nominal=true` reads the ork global config's `phaseNominals.<id>.nominalHashrate_MHS` (fields are omitted when unset), and `groupBy`/`racks`/`container` are rejected for it. Its efficiency divides the consumption series by its pool hashrate, and revenue-summary divides uptime by `phaseNominals.<id>.nominalPower_MW` (`400 ERR_PHASE_NOMINAL_MISSING` when absent).
- Grouped hashrate (`groupBy=miner|container`) additionally carries each pool-only phase's synthetic group key from `groups` (e.g. `HBM` / `acme-container`), filled from that phase's pool hashrate.
- The site summary's efficiency and the high-site-efficiency alert divide by miner hashrate plus the pool-only phases' live pool hashrate, since those phases consume inside the site meter without reporting telemetry.
- `GET /auth/finance/revenue-summary?phase=` scopes earnings (transaction rows are filtered by the accounts' `username` tags) and hashrate; rebates stay on the unscoped view, and a manual-source phase carries no Cost-Input opex. Consumption series stay site-wide until the manual consumption store is wired into the phase seam.
- Limitations in this iteration: phase ids match `[A-Za-z0-9_]+`; at most one telemetry-backed phase is supported (its hashrate series is the whole MOS fleet — the per-phase split of miner telemetry itself would need a rack/group mapping); the grouped summary's site total includes the synthetic groups (the Miner Type view sums every listed group) while the ungrouped site series stays MOS-only, matching the header; `metrics/consumption` and `metrics/downtime` reject a non-`total` `phase` with `400 ERR_PHASE_NOT_SUPPORTED` until the manual consumption store feeds the phase seam.
