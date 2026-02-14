# CortexAI Fleet Manager — Product Requirements Document

## Overview

Build a **multi-tenant fleet management dashboard** that provisions, monitors, and manages CortexAI Assistant instances running on Railway (a cloud PaaS). Each "tenant" represents a client organization, and each tenant owns one or more "instances" — each of which is a full Railway project with its own service, volume, domain, and environment variables.

The app needs a web server backend, a browser-based frontend, and persistent storage (file-based or database — your choice). Authentication is via a single shared password. The app communicates with two external APIs:

- **Railway GraphQL API** (`https://backboard.railway.com/graphql/v2`) — for provisioning and managing cloud infrastructure
- **Tailscale API** (`https://api.tailscale.com/api/v2/`) — optional, for VPN mesh networking

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FLEET_PASSWORD` | Yes | Password for dashboard access (HTTP Basic Auth) |
| `RAILWAY_API_TOKEN` | Yes | Railway API bearer token for provisioning |
| `GITHUB_REPO` | No | GitHub repo for new services (default: `TukaTek/cortexai-assistant`) |
| `PORT` | No | Listen port (default: `8080`) |
| `DATA_DIR` | No | Directory for fleet.json (default: `/data`) |
| `TAILSCALE_CLIENT_ID` | No | Tailscale OAuth client ID (enables Tailscale integration) |
| `TAILSCALE_CLIENT_SECRET` | No | Tailscale OAuth client secret |
| `TAILSCALE_TAILNET` | No | Tailscale tailnet name (default: `-` for default) |
| `TAILSCALE_TAG` | No | Tailscale ACL tag for devices (default: `tag:cortexai`) |

---

## Data Model

### Fleet Store (`fleet.json`)

```json
{
  "version": 2,
  "tenants": {
    "<tenant-uuid>": {
      "id": "uuid",
      "name": "Client XYZ",
      "slug": "client-xyz",
      "createdAt": "2026-02-14T00:00:00.000Z",
      "notes": "Internal notes",
      "tailscale": null,
      "instances": {
        "<instance-uuid>": {
          "id": "uuid",
          "name": "Production",
          "createdAt": "2026-02-14T00:00:00.000Z",
          "railway": {
            "projectId": "railway-project-id",
            "serviceId": "railway-service-id",
            "environmentId": "railway-env-id",
            "volumeId": "railway-volume-id"
          },
          "config": {
            "setupPassword": "hex-string",
            "gatewayToken": "hex-string"
          },
          "tailscale": {
            "hostname": "cortexai-client-xyz"
          },
          "notes": ""
        }
      }
    }
  }
}
```

### Key Data Rules

- On first run (no `fleet.json` exists), auto-create a "Default" tenant with slug `"default"` and an empty instances map.
- Tenants are uniquely identified by UUID. Slugs must be unique across tenants.
- `slugify(name)`: lowercase, replace non-alphanumeric with hyphens, strip leading/trailing hyphens, max 30 chars.
- Instances are nested inside their parent tenant.
- The `tailscale` field on tenants is always `null` for now (future: per-tenant Tailscale credentials).

### Persistence

- **Atomic writes**: Write to `fleet.json.tmp`, then rename over `fleet.json`.
- **Timestamped backups**: Before every write, copy current `fleet.json` to `fleet.bak-{ISO-timestamp}.json`.
- **Auto-migration**: If an old v1 format is loaded (flat `instances` at root), auto-migrate to v2 by wrapping all instances in a new "Default" tenant. Create a `fleet.bak-premigrate.json` backup before migration.

---

## API Endpoints

All endpoints except `/healthz` require HTTP Basic Auth (`Authorization: Basic base64(anything:FLEET_PASSWORD)`).

### Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/healthz` | No | Returns `{ ok: true }` |

### Dashboard

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | Serves the dashboard HTML page |
| GET | `/app.js` | Yes | Serves the client-side JavaScript |

### Tenant CRUD

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tenants` | List all tenants with instance counts |
| POST | `/api/tenants` | Create tenant. Body: `{ name, notes? }`. Validates name (alphanumeric + spaces + hyphens, max 50 chars). Checks for duplicate slug. |
| GET | `/api/tenants/:tenantId` | Get tenant detail with instance count |
| PATCH | `/api/tenants/:tenantId` | Update tenant. Body: `{ name?, notes? }`. Re-slugifies if name changes. |
| DELETE | `/api/tenants/:tenantId` | Delete tenant. **Cascade**: deletes all Railway projects for every instance in the tenant first, then removes the tenant from the store. |

### Instance CRUD (tenant-scoped)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tenants/:tid/instances` | List instances for tenant (enriched with live status from Railway API) |
| POST | `/api/tenants/:tid/instances` | Create new instance (see Instance Creation Flow below) |
| GET | `/api/tenants/:tid/instances/:id` | Get instance detail with fresh live status |
| POST | `/api/tenants/:tid/instances/:id/restart` | Trigger redeployment on Railway |
| POST | `/api/tenants/:tid/instances/:id/redeploy` | Trigger redeployment on Railway |
| DELETE | `/api/tenants/:tid/instances/:id` | Delete Railway project, remove from store |
| GET | `/api/tenants/:tid/instances/:id/health` | Probe the instance's `/healthz` endpoint |

### Backward-Compatibility Shims

These routes resolve to the "Default" tenant (where `slug === "default"`) or search across all tenants:

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/api/instances` | List instances from Default tenant |
| POST | `/api/instances` | Create instance in Default tenant |
| GET | `/api/instances/:id` | Find instance across all tenants |
| POST | `/api/instances/:id/restart` | Find + restart |
| POST | `/api/instances/:id/redeploy` | Find + redeploy |
| DELETE | `/api/instances/:id` | Find + delete |
| GET | `/api/instances/:id/health` | Find + health probe |

---

## Instance Creation Flow

When `POST /api/tenants/:tid/instances` is called, the server executes these steps sequentially via the Railway GraphQL API:

1. **Create Railway project** — Named `"CortexAI - {instanceName}"` for default tenant, or `"CortexAI - {tenantSlug} - {instanceName}"` for non-default tenants.
2. **Get default environment** — Extract the environment ID from the newly created project.
3. **Create service** — Service linked to the GitHub repo (`GITHUB_REPO` env var). Service name: `"cortexai-{slugified-instance-name}"`.
4. **Create volume** — Mounted at `/data` on the service.
5. **Set environment variables** — `SETUP_PASSWORD`, `OPENCLAW_STATE_DIR`, `OPENCLAW_WORKSPACE_DIR`, `OPENCLAW_GATEWAY_TOKEN`, `PORT`, `OPENCLAW_PUBLIC_PORT`.
6. **Generate Tailscale auth key** (optional) — If Tailscale OAuth credentials are configured, generate a pre-authenticated, non-reusable key via the Tailscale API and set `TS_AUTHKEY` + `TS_HOSTNAME` as additional env vars.
7. **Create public domain** — Railway-assigned `.up.railway.app` domain.
8. **Trigger deployment** — Starts the Docker build on Railway.
9. **Save to store** — Persist all IDs (project, service, environment, volume) and config (setup password, gateway token) to `fleet.json`.

The response includes a `log` array with step-by-step progress messages, plus the created instance summary.

---

## Instance Status Resolution

The server fetches live status for each instance by:

1. **Query Railway deployments API** — Get latest deployment status (BUILDING, DEPLOYING, SUCCESS, FAILED, CRASHED, REMOVED).
2. **Query Railway project** — Get domain info (service domains and custom domains).
3. **Health probe** (if deployment is SUCCESS and domain exists) — `GET https://{domain}/healthz` with 5s timeout.

Composite status resolution:

| Railway Status | Health Probe | Composite Status |
|----------------|-------------|------------------|
| No deployment | — | `no-deployment` |
| BUILDING | — | `building` |
| DEPLOYING | — | `deploying` |
| FAILED/CRASHED | — | `failed` |
| SUCCESS | No response | `unhealthy` |
| SUCCESS | `configured: false` | `needs-setup` |
| SUCCESS | `gateway.reachable: true` | `running` |
| SUCCESS | `gateway.reachable: false` | `unhealthy` |
| REMOVED | — | `stopped` |

**Status cache**: Results are cached per-instance for 30 seconds to avoid hammering Railway's API.

---

## Railway GraphQL API

The app communicates with Railway via their GraphQL API at `https://backboard.railway.com/graphql/v2`.

### Authentication
Bearer token in `Authorization` header. Token comes from `RAILWAY_API_TOKEN` env var.

### Rate Limiting
If a 429 response is received, the client waits for the `Retry-After` header value (or 5 seconds) and retries once.

### Required Mutations & Queries

```graphql
# Create a new project
mutation projectCreate($input: ProjectCreateInput!) {
  projectCreate(input: $input) {
    id, name
    environments { edges { node { id, name } } }
  }
}

# Query project details (services, domains, deployments)
query project($id: String!) {
  project(id: $id) {
    id, name
    environments { edges { node { id, name } } }
    services { edges { node {
      id, name
      serviceInstances { edges { node {
        latestDeployment { id, status, createdAt }
        domains {
          serviceDomains { domain }
          customDomains { domain }
        }
      }}}
    }}}
  }
}

# Delete a project
mutation projectDelete($id: String!) {
  projectDelete(id: $id)
}

# Create a service from GitHub repo
mutation serviceCreate($input: ServiceCreateInput!) {
  serviceCreate(input: $input) { id, name }
}

# Create a persistent volume
mutation volumeCreate($input: VolumeCreateInput!) {
  volumeCreate(input: $input) { id }
}

# Set environment variables
mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
  variableCollectionUpsert(input: $input)
}

# Trigger initial deployment
mutation serviceInstanceDeploy($serviceId: String!, $environmentId: String!) {
  serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId)
}

# Trigger redeployment
mutation serviceInstanceRedeploy($serviceId: String!, $environmentId: String!) {
  serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
}

# Query latest deployment status
query deployments($input: DeploymentListInput!) {
  deployments(input: $input, first: 1) {
    edges { node { id, status, createdAt } }
  }
}

# Create a Railway-assigned domain
mutation serviceDomainCreate($input: ServiceDomainCreateInput!) {
  serviceDomainCreate(input: $input) { id, domain }
}
```

---

## Tailscale API (Optional)

If `TAILSCALE_CLIENT_ID` and `TAILSCALE_CLIENT_SECRET` are set, the app generates per-instance VPN auth keys.

### OAuth Token Exchange
```
POST https://api.tailscale.com/api/v2/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id={id}&client_secret={secret}
```

### Auth Key Creation
```
POST https://api.tailscale.com/api/v2/tailnet/{tailnet}/keys
Authorization: Bearer {oauth_token}
Content-Type: application/json

{
  "capabilities": {
    "devices": {
      "create": {
        "reusable": false,
        "ephemeral": false,
        "preauthorized": true,
        "tags": ["tag:cortexai"]
      }
    }
  },
  "expirySeconds": 7776000,
  "description": "Fleet: {hostname}"
}
```

Returns `{ key: "tskey-auth-...", id: "..." }`. The `key` is set as `TS_AUTHKEY` in the Railway instance's environment variables.

---

## Frontend (Dashboard UI)

The dashboard is a single-page app with two views. Use whatever frontend approach you prefer (React, Vue, vanilla JS, etc.).

### Architecture

- **Two-view state machine**: the page switches between "tenants" view and "instances" view
- Served from the same backend server

### Views

#### 1. Tenants View (default landing page)
- Grid of tenant cards (CSS Grid, responsive: `repeat(auto-fill, minmax(320px, 1fr))`)
- Each card shows: tenant name, instance count, notes, creation date, delete button
- Clicking a card navigates to that tenant's instances view
- "New Tenant" button opens inline create form (name + notes fields)
- Tenant delete has double-confirmation (extra warning if tenant has instances)

#### 2. Instances View (within a tenant)
- Breadcrumb navigation: `All Tenants > {Tenant Name}`
- Grid of instance cards showing:
  - Instance name
  - Status indicator (colored dot + label)
  - Domain link (clickable, opens in new tab)
  - Setup password (displayed in `<code>` tag)
  - Tailscale hostname (if configured, green link)
  - Notes
  - Creation date
  - Action buttons: "Open Setup", "Open CortexAI", "Restart", "Redeploy", "Delete"
- "New Instance" button opens inline create form (name + password + notes fields)
- Create form shows a `<pre>` log area with step-by-step progress from the server
- Instance delete has double-confirmation

### Navigation

- Breadcrumb "All Tenants" link → switches to tenants view
- Tenant card click → switches to instances view for that tenant
- The "New" button label changes based on current view ("New Tenant" vs "New Instance")
- "Refresh" button reloads the current view

### Status Indicators

| Status | Dot Color | Label |
|--------|-----------|-------|
| running | Green (#4ade80) | Running |
| needs-setup | Yellow (#facc15) | Needs Setup |
| building | Blue (#60a5fa) | Building |
| deploying | Blue (#60a5fa) | Deploying |
| failed | Red (#f87171) | Failed |
| unhealthy | Orange (#fb923c) | Unhealthy |
| stopped | Gray (#6b7280) | Stopped |
| no-deployment | Gray (#6b7280) | No Deployment |
| unknown | Gray (#6b7280) | Unknown |

### Visual Design

- **Dark theme**: Background `#0a0a0a`, cards `#141414`, borders `#2a2a2a`
- **Primary accent**: Orange `#FF6B35` (used for headings, links, primary buttons, hover states)
- **Text**: Light gray `#e2e8f0`, muted `#94a3b8`
- **Cards**: 12px border radius, subtle box shadow (`0 4px 12px rgba(0,0,0,0.4)`)
- **Buttons**: Gradient primary (`linear-gradient(135deg, #FF6B35, #E85D2E)`), outlined secondary, dark muted, dark red danger
- **Inputs**: Dark background `#1a1a1a`, 8px border radius
- **Tenant cards**: Hover effect changes border color to orange
- **Instance count**: Green (#4ade80) with bold weight
- **Responsive**: Single column below 600px

### API Communication

Error responses should show the HTTP status and error message inline in the UI.

---

## Important Behavioral Notes

1. **Name sanitization** — Tenant and instance names must be sanitized to alphanumeric characters, spaces, and hyphens only, max 50 chars. Must result in a non-empty string after sanitization.

2. **Setup password generation** — If the user doesn't provide one, auto-generate a secure random password.

3. **Gateway token generation** — Always auto-generated as a secure random token.

4. **Cascade deletes** — Deleting a tenant must delete all Railway projects for every instance in that tenant first. Errors during cascade are logged but don't prevent tenant removal.

5. **Backward compatibility** — The `/api/instances` routes (without tenant ID) must resolve to the Default tenant or search across all tenants. This is important for external integrations that may use the flat API.

6. **Status caching** — Live status (Railway deployment state + health probe) should be cached per-instance for ~30 seconds to avoid hammering the Railway API. Instance detail endpoints should bust the cache to show fresh data.

7. **Default tenant on first run** — When there's no existing data, the app must auto-create a "Default" tenant so the dashboard isn't empty/broken.
