# miningos-app-node

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Quick Start](#quick-start)
4. [Configuration](#configuration)
5. [API Reference](#api-reference)

---

## Overview

### Purpose

`miningos-app-node` serves as the **HTTP API gateway** for MiningOS. 

### Key Features

- **HTTP API Gateway** - RESTful fastify APIs
- **OAuth2 Authentication** (Google) with token-based authorization
- **Role-Based Access Control (RBAC)** - Multiple user roles with granular permissions
- **Multi-Cluster RPC** - Communicates with multiple orchestrator clusters via DHT-based RPC
- **Request Caching** - Configurable LRU caching (10s, 15s, 30s, 15m TTLs)
- **Request Deduplication** - Prevents duplicate concurrent requests
- **Audit Logging** - Comprehensive logging of user management and security events
- **Schema Validation** - JSON Schema validation for all endpoints (Fastify)

---

## Architecture

### Technology Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Runtime** | Node.js ≥20 | JavaScript execution environment |
| **Base Framework** | tether-wrk-base | P2P networking and storage foundation |
| **Web Framework** | Fastify | High-performance HTTP server |
| **P2P Network** | Hyperswarm | DHT-based peer-to-peer networking |
| **P2P Storage** | Hyperbee | Distributed append-only B-tree |
| **Authentication** | svc-facs-auth + OAuth2 | Token-based auth with Google OAuth |
| **Local DB** | SQLite (bfx-facs-db-sqlite) | User management and session storage |
| **Caching** | LRU (bfx-facs-lru) | In-memory request caching |
| **Logging** | Pino (svc-facs-logging) | Structured JSON logging with transport |
| **Testing** | Brittle | Modern TAP test runner |

### Data Flow

1. **Client Request** → HTTP API (Fastify)
2. **Authentication** → Token validation (cached, 1-minute TTL)
3. **Authorization** → Permission check (role + capability)
4. **Cache Check** → LRU cache lookup (if applicable)
5. **Request Deduplication** → Queue identical concurrent requests
6. **RPC Aggregation** → Parallel DHT-based RPC requests to ORK clusters (max 2 concurrent)
7. **Response Aggregation** → Merge results from multiple ORKs
8. **Cache Update** → Store result in LRU cache
9. **Audit Log** → Log sensitive operations (if enabled)
10. **Response** → JSON response to client

---

## Quick Start
### Prerequisites

- Node.js ≥20.0
- npm
- Git

### Installation

```bash
# Clone the repository
git clone https://github.com/tetherto/miningos-app-node.git
cd miningos-app-node

# Install dependencies
npm install

# Setup configuration files
./setup-config.sh

# (Optional) Include test configuration
./setup-config.sh --test
```

### Basic Configuration

#### 1. Common Configuration

Edit `config/common.json`:

```json
{
  "dir_log": "logs",
  "debug": 0,
  "site": "production-site-01",
  "ttl": 300,
  "staticRootPath": "/path/to/mos-app-ui/build/",
  "orks": {
    "cluster-1": {
      "rpcPublicKey": "YOUR_ORK_RPC_PUBLIC_KEY_HERE"
    },
    "cluster-2": {
      "rpcPublicKey": "YOUR_ORK_RPC_PUBLIC_KEY_HERE"
    }
  },
  "cacheTiming": {
    "/auth/list-things": "30s",
    "/auth/tail-log": "15s",
    "/auth/global/data": "15m",
    "/auth/actions": "10s"
  },
  "featureConfig": {}
}
```

**Configuration Notes:**
- **`dir_log`**: Directory for log files (required)
- **`ttl`**: Token time-to-live in seconds (default: 300 = 5 minutes)
- **`staticRootPath`**: Path to the UI build directory (required if serving frontend)
- **`cacheTiming`**: Per-endpoint cache TTL values (available: "10s", "15s", "30s", "15m")
- **`featureConfig`**: Feature flags (see `config/common.json.example` for all available options)

#### 2. OAuth2 Configuration

Edit `config/facs/httpd-oauth2.config.json`:

```json
{
  "h0": {
    "method": "google",
    "credentials": {
      "client": {
        "id": "YOUR_GOOGLE_CLIENT_ID",
        "secret": "YOUR_GOOGLE_CLIENT_SECRET"
      }
    },
    "users": [
      { "email": "admin@yourcompany.com", "write": true },
      { "email": "operator@yourcompany.com", "write": true },
      { "email": "viewer@yourcompany.com", "write": false }
    ]
  }
}
```

#### 3. Authentication & Roles Configuration

Set superAdmin email in `config/facs/auth.config.json` (see full example in Configuration section)

### Running the Service

```bash
# Development mode
node worker.js --wtype wrk-node-http --env development --port 3000

# Production mode
node worker.js --wtype wrk-node-http --env production --port 3000

# With debug logging
DEBUG="*" node worker.js --wtype wrk-node-http --env development --port 3000
```

---

## Configuration

**Note:** Configuration files are created by running `./setup-config.sh`, which copies `.example` files to actual config files.

### Configuration Details

#### `config/common.json`

```json
{
  "debug": 0,
  "site": "production-site-01",
  "staticRootPath": "/home/user/dev/mos-app-ui/build/",
  "ttl": 300,
  "dir_log": "logs",
  "orks": {
    "cluster-1": { "rpcPublicKey": "abc123..." },
    "cluster-2": { "rpcPublicKey": "def456..." }
  },
  "cacheTiming": {
    "/auth/list-things": "15s",
    "/auth/tail-log": "15s",
    "/auth/actions/batch": "30s",
    "/auth/actions/:type": "30s",
    "/auth/actions/:type/:id": "30s",
    "/auth/global/data": "30s"
  },
  "featureConfig": {
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
}
```

**Fields:**
- `debug`: Debug level (0 = info, 1+ = debug)
- `site`: Site identifier for this node
- `staticRootPath`: Path to static UI files served by HTTP server
- `ttl`: Authentication token TTL in seconds (default: 300)
- `dir_log`: Log directory path
- `orks`: Map of ORK cluster names to RPC public keys
- `cacheTiming`: Cache TTL per endpoint (available TTLs: 10s, 15s, 30s, 15m)
- `featureConfig`: Static feature flags for enabling/disabling UI features

**Cache Timing Notes:**
- Use endpoint paths as keys (e.g., `/auth/list-things`)
- Supported TTL values: `10s`, `15s`, `30s`, `15m`
- Unspecified endpoints default to `30s`

#### `config/facs/auth.config.json`

```json
{
  "a0": {
    "superAdmin": "superadmin@company.com",
    "ttl": 86400,
    "saltRounds": 10,
    "superAdminPerms": [
      "miner:rw",
      "container:rw",
      "minerpool:rw",
      "powermeter:rw",
      "temp:rw",
      "electricity:rw",
      "features:rw",
      "revenue:rw",
      "users:rw",
      "actions:rw",
      "production:rw",
      "alerts:rw",
      "cabinets:rw",
      "comments:rw",
      "explorer:rw",
      "inventory:rw",
      "reporting:rw",
      "settings:rw",
      "ticket:rw",
      "forecast_summary:rw",
      "forecast_overview:rw",
      "forecast_settings:rw"
    ],
    "roles": {
      "admin": [
        "miner:rw",
        "container:rw",
        "minerpool:rw",
        "powermeter:rw",
        "temp:rw",
        "electricity:rw",
        "features:rw",
        "revenue:rw",
        "users:rw",
        "actions:rw",
        "production:rw",
        "alerts:rw",
        "cabinets:rw",
        "comments:rw",
        "explorer:rw",
        "inventory:rw",
        "reporting:rw",
        "settings:rw",
        "ticket:rw",
        "forecast_summary:rw",
        "forecast_overview:rw",
        "forecast_settings:rw"
      ],
      "reporting_tool_manager": [
        "revenue:rw",
        "production:rw",
        "reporting:rw",
        "settings:r",
        "forecast_summary:r",
        "forecast_overview:r",
        "forecast_settings:r"
      ],
      "site_manager": [
        "miner:rw",
        "container:rw",
        "minerpool:rw",
        "powermeter:rw",
        "temp:rw",
        "electricity:rw",
        "actions:rw",
        "alerts:rw",
        "cabinets:rw",
        "comments:rw",
        "explorer:rw",
        "inventory:rw",
        "reporting:rw",
        "settings:rw",
        "ticket:rw"
      ],
      "site_operator": [
        "miner:rw",
        "container:rw",
        "minerpool:rw",
        "powermeter:rw",
        "temp:rw",
        "actions:rw",
        "electricity:rw",
        "explorer:rw",
        "inventory:rw",
        "reporting:rw",
        "cabinets:rw",
        "comments:rw",
        "settings:rw",
        "ticket:rw",
        "alerts:rw"
      ],
      "field_operator": [
        "miner:r",
        "container:r",
        "minerpool:r",
        "powermeter:r",
        "temp:r",
        "electricity:r",
        "explorer:r",
        "inventory:r",
        "reporting:r",
        "cabinets:r",
        "comments:rw",
        "settings:r",
        "ticket:r",
        "alerts:r"
      ],
      "repair_technician": [
        "miner:r",
        "container:r",
        "minerpool:r",
        "powermeter:r",
        "temp:r",
        "actions:rw",
        "electricity:r",
        "explorer:r",
        "inventory:rw",
        "cabinets:r",
        "comments:rw",
        "settings:r",
        "ticket:r",
        "alerts:r"
      ],
      "read_only_user": [
        "miner:r",
        "container:r",
        "minerpool:r",
        "powermeter:r",
        "temp:r",
        "electricity:r",
        "explorer:r",
        "inventory:r",
        "reporting:r",
        "cabinets:r",
        "comments:r",
        "settings:r",
        "ticket:r",
        "alerts:r"
      ],
      "dev": [
        "miner:r",
        "container:r",
        "minerpool:r",
        "powermeter:r",
        "temp:r",
        "electricity:r",
        "explorer:rw",
        "inventory:rw",
        "reporting:rw",
        "cabinets:rw",
        "comments:rw",
        "settings:rw",
        "ticket:rw",
        "alerts:rw"
      ]
    },
    "roleManagement": {
      "admin": [
        "site_manager",
        "site_operator",
        "reporting_tool_manager",
        "field_operator",
        "repair_technician",
        "read_only_user",
        "dev"
      ]
    }
  }
}
```

**Fields:**
- `superAdmin`: Email of the super administrator (cannot be modified/deleted)
- `ttl`: Token time-to-live in seconds (default: 86400 = 24 hours)
- `saltRounds`: BCrypt salt rounds for password hashing
- `superAdminPerms`: Permissions granted to super administrator
- `roles`: Role definitions with their associated permissions
- `roleManagement`: Defines which roles can manage other roles

**Permission Format:**
- Permissions use format `resource:access` where access can be:
  - `r` = read-only
  - `rw` = read and write
- Example: `"miner:rw"` grants read and write access to miner resources

**Available Roles:**
- `admin` - Full administrative access, can manage all other roles
- `reporting_tool_manager` - Access to revenue, production, and reporting features
- `site_manager` - Full site operations without user/feature management
- `site_operator` - Day-to-day mining operations
- `field_operator` - Read-only access with comment/ticket creation
- `repair_technician` - Read access with action/inventory/comment management
- `read_only_user` - Read-only access to all resources
- `dev` - Developer access with elevated explorer/inventory/settings permissions

**Role Management Rules:**
- `superAdmin`: Designated user with all permissions, cannot be modified/deleted via API
- `admin`: Can manage all roles listed in `roleManagement.admin` array
- Other roles: Cannot manage users (not present in `roleManagement` object)

#### `config/facs/httpd-oauth2.config.json`

```json
{
  "h0": {
    "method": "google",
    "credentials": {
      "client": {
        "id": "<CLIENT_ID>",
        "secret": "<CLIENT_SECRET>"
      }
    },
    "startRedirectPath": "/oauth/google",
    "callbackUri": "http://localhost:3000/oauth/google/callback",
    "callbackUriUI": "http://localhost:3030"
  }
}
```

**Fields:**
- `method`: OAuth provider (currently only `"google"` supported)
- `credentials.client.id`: Google OAuth2 client ID
- `credentials.client.secret`: Google OAuth2 client secret
- `startRedirectPath`: Initiation path for OAuth flow
- `callbackUri`: OAuth callback URL (must match Google Console configuration)
- `callbackUriUI`: Frontend redirect URL after authentication

**Capability Codes:**
- `m` = miner
- `c` = container
- `mp` = minerpool
- `p` = powermeter
- `t` = temperature
- `e` = electricity
- `f` = features
- `r` = revenue

**OAuth Flow:**
1. User visits `/oauth/google` on the app-node
2. Redirected to Google authentication
3. After auth, Google redirects to `callbackUri`
4. App-node issues token and redirects to `callbackUriUI`

---

## API Reference
[API](./docs/API.md)
