// Fleet Manager for CortexAI Assistant Railway instances.
// Provides a web UI to create, monitor, and manage multiple instances.

import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  railwayGql,
  PROJECT_CREATE,
  PROJECT_QUERY,
  PROJECT_DELETE,
  SERVICE_CREATE,
  VOLUME_CREATE,
  VARIABLE_COLLECTION_UPSERT,
  SERVICE_INSTANCE_DEPLOY,
  SERVICE_INSTANCE_REDEPLOY,
  DEPLOYMENTS_QUERY,
  SERVICE_DOMAIN_CREATE,
} from "./railway-api.js";

import * as store from "./store.js";
import { slugify } from "./store.js";
import {
  isTailscaleConfigured,
  getTailscaleToken,
  createAuthKey,
} from "./tailscale-api.js";

// --- Configuration ---

const PORT = parseInt(process.env.PORT || "8080", 10);
const FLEET_PASSWORD = process.env.FLEET_PASSWORD || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "TukaTek/cortexai-assistant";

if (!FLEET_PASSWORD) {
  console.warn("[fleet] WARNING: FLEET_PASSWORD not set — dashboard will reject all requests.");
}

// --- Express app ---

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- Auth middleware ---

function requireAuth(req, res, next) {
  if (!FLEET_PASSWORD) {
    return res.status(500).send("FLEET_PASSWORD not configured on server.");
  }
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Fleet Manager"');
    return res.status(401).send("Authentication required.");
  }
  const decoded = Buffer.from(auth.slice(6), "base64").toString();
  const colonIdx = decoded.indexOf(":");
  const pass = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded;
  if (pass !== FLEET_PASSWORD) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Fleet Manager"');
    return res.status(401).send("Invalid password.");
  }
  next();
}

// --- Health check (no auth) ---

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// --- Dashboard HTML ---

app.get("/", requireAuth, (_req, res) => {
  res.type("html").send(DASHBOARD_HTML);
});

app.get("/app.js", requireAuth, (_req, res) => {
  const jsPath = path.join(import.meta.dirname, "manager-app.js");
  try {
    const content = fs.readFileSync(jsPath, "utf8");
    res.type("application/javascript").send(content);
  } catch {
    res.status(404).send("// manager-app.js not found");
  }
});

// --- Status cache ---

const statusCache = new Map(); // instanceId -> { data, fetchedAt }
const STATUS_CACHE_TTL = 30_000; // 30 seconds

async function getInstanceStatus(instance) {
  const cached = statusCache.get(instance.id);
  if (cached && Date.now() - cached.fetchedAt < STATUS_CACHE_TTL) {
    return cached.data;
  }

  let deployment = null;
  let domain = null;
  let health = null;

  try {
    // Fetch latest deployment from Railway API.
    const depData = await railwayGql(DEPLOYMENTS_QUERY, {
      input: {
        serviceId: instance.railway.serviceId,
        environmentId: instance.railway.environmentId,
      },
    });
    const edge = depData.deployments?.edges?.[0];
    if (edge) {
      deployment = {
        id: edge.node.id,
        status: edge.node.status,
        createdAt: edge.node.createdAt,
      };
    }

    // Fetch domain info.
    const projData = await railwayGql(PROJECT_QUERY, {
      id: instance.railway.projectId,
    });
    const svc = projData.project?.services?.edges?.find(
      (e) => e.node.id === instance.railway.serviceId,
    );
    if (svc) {
      const inst = svc.node.serviceInstances?.edges?.[0]?.node;
      const sd = inst?.domains?.serviceDomains?.[0]?.domain;
      const cd = inst?.domains?.customDomains?.[0]?.domain;
      domain = cd || sd || null;
    }
  } catch (err) {
    deployment = { status: "UNKNOWN", error: String(err) };
  }

  // If deployment is running, probe the instance's /healthz.
  if (domain && deployment?.status === "SUCCESS") {
    try {
      const hRes = await fetch(`https://${domain}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      if (hRes.ok) {
        health = await hRes.json();
      }
    } catch {
      health = null;
    }
  }

  // Resolve composite status.
  let compositeStatus = "unknown";
  if (!deployment) {
    compositeStatus = "no-deployment";
  } else if (deployment.status === "BUILDING") {
    compositeStatus = "building";
  } else if (deployment.status === "DEPLOYING") {
    compositeStatus = "deploying";
  } else if (
    deployment.status === "FAILED" ||
    deployment.status === "CRASHED"
  ) {
    compositeStatus = "failed";
  } else if (deployment.status === "SUCCESS") {
    if (!health) {
      compositeStatus = "unhealthy";
    } else if (!health.configured) {
      compositeStatus = "needs-setup";
    } else if (health.gateway?.reachable) {
      compositeStatus = "running";
    } else {
      compositeStatus = "unhealthy";
    }
  } else if (deployment.status === "REMOVED") {
    compositeStatus = "stopped";
  }

  const statusData = { deployment, domain, health, status: compositeStatus };
  statusCache.set(instance.id, { data: statusData, fetchedAt: Date.now() });
  return statusData;
}

// Helper to enrich an instance with live status data.
async function enrichInstance(inst) {
  const live = await getInstanceStatus(inst).catch(() => ({
    status: "unknown",
  }));
  return {
    id: inst.id,
    name: inst.name,
    createdAt: inst.createdAt,
    notes: inst.notes,
    setupPassword: inst.config?.setupPassword,
    domain: live.domain,
    status: live.status,
    deployment: live.deployment,
    tailscale: inst.tailscale || null,
  };
}

// ============================================================
//  TENANT API
// ============================================================

// --- List tenants ---

app.get("/api/tenants", requireAuth, (_req, res) => {
  try {
    res.json({ ok: true, tenants: store.getAllTenants() });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// --- Create tenant ---

app.post("/api/tenants", requireAuth, (req, res) => {
  try {
    const { name, notes } = req.body || {};
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ ok: false, error: "Name is required." });
    }

    const cleanName = name.trim().replace(/[^a-zA-Z0-9 -]/g, "").slice(0, 50);
    if (!cleanName) {
      return res.status(400).json({ ok: false, error: "Name must contain alphanumeric characters." });
    }

    const slug = slugify(cleanName);

    // Check for duplicate slug.
    const existing = store.getAllTenants().find((t) => t.slug === slug);
    if (existing) {
      return res.status(409).json({ ok: false, error: `A tenant with slug "${slug}" already exists.` });
    }

    const tenant = store.addTenant({
      id: crypto.randomUUID(),
      name: cleanName,
      slug,
      createdAt: new Date().toISOString(),
      notes: notes || "",
      tailscale: null, // Pluggable — configured in a future phase.
    });

    console.log(`[fleet] Tenant created: "${cleanName}" (${tenant.id})`);
    res.json({ ok: true, tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug } });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// --- Get tenant detail ---

app.get("/api/tenants/:tenantId", requireAuth, (req, res) => {
  try {
    const tenant = store.getTenant(req.params.tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: "Tenant not found." });

    res.json({
      ok: true,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        createdAt: tenant.createdAt,
        notes: tenant.notes,
        tailscale: tenant.tailscale || null,
        instanceCount: Object.keys(tenant.instances || {}).length,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// --- Update tenant ---

app.patch("/api/tenants/:tenantId", requireAuth, (req, res) => {
  try {
    const { name, notes } = req.body || {};
    const patch = {};
    if (name !== undefined) {
      const cleanName = String(name).trim().replace(/[^a-zA-Z0-9 -]/g, "").slice(0, 50);
      if (!cleanName) {
        return res.status(400).json({ ok: false, error: "Name must contain alphanumeric characters." });
      }
      patch.name = cleanName;
      patch.slug = slugify(cleanName);
    }
    if (notes !== undefined) patch.notes = notes;

    const updated = store.updateTenant(req.params.tenantId, patch);
    if (!updated) return res.status(404).json({ ok: false, error: "Tenant not found." });

    res.json({ ok: true, tenant: { id: updated.id, name: updated.name, slug: updated.slug, notes: updated.notes } });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// --- Delete tenant (cascades: deletes all Railway projects) ---

app.delete("/api/tenants/:tenantId", requireAuth, async (req, res) => {
  try {
    const tenant = store.getTenant(req.params.tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: "Tenant not found." });

    const instances = Object.values(tenant.instances || {});
    if (instances.length > 0) {
      // Cascade delete all Railway projects.
      const errors = [];
      for (const inst of instances) {
        try {
          await railwayGql(PROJECT_DELETE, { id: inst.railway.projectId });
          statusCache.delete(inst.id);
        } catch (e) {
          errors.push(`${inst.name}: ${String(e)}`);
        }
      }
      if (errors.length > 0) {
        console.warn(`[fleet] Tenant delete partial errors: ${errors.join("; ")}`);
      }
    }

    store.removeTenant(tenant.id);
    console.log(`[fleet] Tenant deleted: "${tenant.name}" (${tenant.id}), ${instances.length} instance(s) removed.`);

    res.json({ ok: true, message: `Deleted tenant "${tenant.name}" and ${instances.length} instance(s).` });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ============================================================
//  INSTANCE API (tenant-scoped)
// ============================================================

// --- List instances for a tenant ---

app.get("/api/tenants/:tid/instances", requireAuth, async (req, res) => {
  try {
    const tenant = store.getTenant(req.params.tid);
    if (!tenant) return res.status(404).json({ ok: false, error: "Tenant not found." });

    const instances = store.getAllInstances(req.params.tid);
    const enriched = await Promise.all(instances.map(enrichInstance));
    res.json({ ok: true, instances: enriched });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// --- Get instance detail ---

app.get("/api/tenants/:tid/instances/:id", requireAuth, async (req, res) => {
  try {
    const instance = store.getInstance(req.params.tid, req.params.id);
    if (!instance) return res.status(404).json({ ok: false, error: "Not found" });

    statusCache.delete(instance.id);
    const live = await getInstanceStatus(instance).catch(() => ({
      status: "unknown",
    }));

    res.json({
      ok: true,
      instance: {
        ...instance,
        config: { setupPassword: instance.config?.setupPassword },
        live,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// --- Create instance in a tenant ---

app.post("/api/tenants/:tid/instances", requireAuth, async (req, res) => {
  try {
    const tenant = store.getTenant(req.params.tid);
    if (!tenant) return res.status(404).json({ ok: false, error: "Tenant not found." });

    const { name, setupPassword, notes } = req.body || {};
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ ok: false, error: "Name is required." });
    }

    const cleanName = name.trim().replace(/[^a-zA-Z0-9 -]/g, "").slice(0, 50);
    if (!cleanName) {
      return res.status(400).json({ ok: false, error: "Name must contain alphanumeric characters." });
    }

    const finalSetupPassword =
      setupPassword || crypto.randomBytes(16).toString("hex");
    const gatewayToken = crypto.randomBytes(32).toString("hex");
    const instanceId = crypto.randomUUID();

    const log = [];
    function addLog(msg) {
      log.push(msg);
      console.log(`[fleet] [${tenant.slug}/${cleanName}] ${msg}`);
    }

    // Step 1: Create Railway project (named with tenant context).
    const projectLabel = tenant.slug === "default"
      ? `CortexAI - ${cleanName}`
      : `CortexAI - ${tenant.slug} - ${cleanName}`;
    addLog(`Creating Railway project "${projectLabel}"...`);
    const project = await railwayGql(PROJECT_CREATE, {
      input: { name: projectLabel },
    });
    const projectId = project.projectCreate.id;
    addLog(`Project created: ${projectId}`);

    // Step 2: Get default environment.
    const envEdge = project.projectCreate.environments?.edges?.[0];
    if (!envEdge) throw new Error("No default environment found in new project.");
    const environmentId = envEdge.node.id;
    addLog(`Environment: ${envEdge.node.name} (${environmentId})`);

    // Step 3: Create service from GitHub repo.
    const serviceSlug = "cortexai-" + cleanName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    addLog(`Creating service "${serviceSlug}" from ${GITHUB_REPO}...`);
    const service = await railwayGql(SERVICE_CREATE, {
      input: {
        projectId,
        name: serviceSlug,
        source: { repo: GITHUB_REPO },
      },
    });
    const serviceId = service.serviceCreate.id;
    addLog(`Service created: ${serviceId}`);

    // Step 4: Create volume.
    addLog("Creating volume at /data...");
    const volume = await railwayGql(VOLUME_CREATE, {
      input: { projectId, serviceId, environmentId, mountPath: "/data" },
    });
    const volumeId = volume.volumeCreate.id;
    addLog(`Volume created: ${volumeId}`);

    // Step 5: Set environment variables.
    addLog("Setting environment variables...");
    await railwayGql(VARIABLE_COLLECTION_UPSERT, {
      input: {
        projectId,
        environmentId,
        serviceId,
        variables: {
          SETUP_PASSWORD: finalSetupPassword,
          OPENCLAW_STATE_DIR: "/data/.openclaw",
          OPENCLAW_WORKSPACE_DIR: "/data/workspace",
          OPENCLAW_GATEWAY_TOKEN: gatewayToken,
          PORT: "8080",
          OPENCLAW_PUBLIC_PORT: "8080",
        },
        replace: false,
      },
    });
    addLog("Variables set.");

    // Step 5b: Generate Tailscale auth key.
    // Future: use tenant.tailscale credentials if present; for now, global.
    let tailscaleHostname = null;
    if (isTailscaleConfigured()) {
      try {
        addLog("Generating Tailscale auth key...");
        const tsToken = await getTailscaleToken();
        const tsKey = await createAuthKey(tsToken, serviceSlug);
        await railwayGql(VARIABLE_COLLECTION_UPSERT, {
          input: {
            projectId,
            environmentId,
            serviceId,
            variables: { TS_AUTHKEY: tsKey.key, TS_HOSTNAME: serviceSlug },
            replace: false,
          },
        });
        tailscaleHostname = serviceSlug;
        addLog(`Tailscale key created. Device will join as "${serviceSlug}".`);
      } catch (e) {
        addLog(`Tailscale setup skipped: ${String(e)}`);
      }
    }

    // Step 6: Create a public domain.
    addLog("Creating public domain...");
    try {
      const domainResult = await railwayGql(SERVICE_DOMAIN_CREATE, {
        input: { serviceId, environmentId },
      });
      addLog(`Domain: ${domainResult.serviceDomainCreate?.domain || "(pending)"}`);
    } catch (e) {
      addLog(`Domain creation note: ${String(e)} (may auto-assign later).`);
    }

    // Step 7: Trigger deployment.
    addLog("Triggering deployment...");
    await railwayGql(SERVICE_INSTANCE_DEPLOY, { serviceId, environmentId });
    addLog("Deployment triggered. Build will take several minutes.");

    // Step 8: Save to store (tenant-scoped).
    const instance = store.addInstance(req.params.tid, {
      id: instanceId,
      name: cleanName,
      createdAt: new Date().toISOString(),
      railway: { projectId, serviceId, environmentId, volumeId },
      config: { setupPassword: finalSetupPassword, gatewayToken },
      tailscale: tailscaleHostname ? { hostname: tailscaleHostname } : null,
      notes: notes || "",
    });

    addLog("Instance saved to fleet store.");

    res.json({
      ok: true,
      instance: {
        id: instanceId,
        name: cleanName,
        setupPassword: finalSetupPassword,
        railway: { projectId, serviceId, environmentId },
      },
      log,
    });
  } catch (err) {
    console.error("[fleet] create error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// --- Restart instance ---

app.post("/api/tenants/:tid/instances/:id/restart", requireAuth, async (req, res) => {
  try {
    const instance = store.getInstance(req.params.tid, req.params.id);
    if (!instance) return res.status(404).json({ ok: false, error: "Not found" });

    await railwayGql(SERVICE_INSTANCE_REDEPLOY, {
      serviceId: instance.railway.serviceId,
      environmentId: instance.railway.environmentId,
    });

    statusCache.delete(instance.id);
    res.json({ ok: true, message: "Redeployment triggered." });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// --- Redeploy instance ---

app.post("/api/tenants/:tid/instances/:id/redeploy", requireAuth, async (req, res) => {
  try {
    const instance = store.getInstance(req.params.tid, req.params.id);
    if (!instance) return res.status(404).json({ ok: false, error: "Not found" });

    await railwayGql(SERVICE_INSTANCE_REDEPLOY, {
      serviceId: instance.railway.serviceId,
      environmentId: instance.railway.environmentId,
    });

    statusCache.delete(instance.id);
    res.json({ ok: true, message: "Redeployment triggered." });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// --- Delete instance ---

app.delete("/api/tenants/:tid/instances/:id", requireAuth, async (req, res) => {
  try {
    const instance = store.getInstance(req.params.tid, req.params.id);
    if (!instance) return res.status(404).json({ ok: false, error: "Not found" });

    await railwayGql(PROJECT_DELETE, { id: instance.railway.projectId });

    store.removeInstance(req.params.tid, instance.id);
    statusCache.delete(instance.id);

    res.json({ ok: true, message: `Deleted project for "${instance.name}".` });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// --- Health probe ---

app.get("/api/tenants/:tid/instances/:id/health", requireAuth, async (req, res) => {
  try {
    const instance = store.getInstance(req.params.tid, req.params.id);
    if (!instance) return res.status(404).json({ ok: false, error: "Not found" });

    const cached = statusCache.get(instance.id);
    const domain = cached?.data?.domain;
    if (!domain) {
      return res.json({ ok: false, error: "Domain not yet available." });
    }

    const hRes = await fetch(`https://${domain}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    if (hRes.ok) {
      const data = await hRes.json();
      res.json({ ok: true, health: data });
    } else {
      res.json({ ok: false, status: hRes.status });
    }
  } catch (err) {
    res.json({ ok: false, error: String(err) });
  }
});

// ============================================================
//  BACKWARD-COMPAT: /api/instances → Default tenant
// ============================================================

function resolveDefaultTenant(res) {
  const def = store.getDefaultTenant();
  if (!def) {
    res.status(404).json({ ok: false, error: "No default tenant found." });
    return null;
  }
  return def;
}

app.get("/api/instances", requireAuth, async (req, res) => {
  const def = resolveDefaultTenant(res);
  if (!def) return;
  req.params.tid = def.id;
  // Forward to tenant-scoped handler.
  try {
    const instances = store.getAllInstances(def.id);
    const enriched = await Promise.all(instances.map(enrichInstance));
    res.json({ ok: true, instances: enriched });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/api/instances/:id", requireAuth, async (req, res) => {
  const found = store.findInstanceAcrossTenants(req.params.id);
  if (!found) return res.status(404).json({ ok: false, error: "Not found" });

  statusCache.delete(found.instance.id);
  const live = await getInstanceStatus(found.instance).catch(() => ({
    status: "unknown",
  }));
  res.json({
    ok: true,
    instance: {
      ...found.instance,
      config: { setupPassword: found.instance.config?.setupPassword },
      live,
    },
  });
});

app.post("/api/instances", requireAuth, async (req, res) => {
  const def = resolveDefaultTenant(res);
  if (!def) return;
  // Inject tenant ID and forward.
  req.params.tid = def.id;
  // Re-dispatch by calling the handler directly isn't clean, so inline:
  try {
    const { name, setupPassword, notes } = req.body || {};
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ ok: false, error: "Name is required." });
    }
    // Redirect client to use the tenant-scoped endpoint.
    // For now, create in default tenant inline.
    const cleanName = name.trim().replace(/[^a-zA-Z0-9 -]/g, "").slice(0, 50);
    if (!cleanName) {
      return res.status(400).json({ ok: false, error: "Name must contain alphanumeric characters." });
    }

    const finalSetupPassword = setupPassword || crypto.randomBytes(16).toString("hex");
    const gatewayToken = crypto.randomBytes(32).toString("hex");
    const instanceId = crypto.randomUUID();
    const log = [];
    function addLog(msg) { log.push(msg); console.log(`[fleet] [${cleanName}] ${msg}`); }

    addLog("Creating Railway project...");
    const project = await railwayGql(PROJECT_CREATE, { input: { name: `CortexAI - ${cleanName}` } });
    const projectId = project.projectCreate.id;
    addLog(`Project created: ${projectId}`);

    const envEdge = project.projectCreate.environments?.edges?.[0];
    if (!envEdge) throw new Error("No default environment found in new project.");
    const environmentId = envEdge.node.id;
    addLog(`Environment: ${envEdge.node.name} (${environmentId})`);

    const serviceSlug = "cortexai-" + cleanName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    addLog(`Creating service "${serviceSlug}" from ${GITHUB_REPO}...`);
    const service = await railwayGql(SERVICE_CREATE, { input: { projectId, name: serviceSlug, source: { repo: GITHUB_REPO } } });
    const serviceId = service.serviceCreate.id;
    addLog(`Service created: ${serviceId}`);

    addLog("Creating volume at /data...");
    const volume = await railwayGql(VOLUME_CREATE, { input: { projectId, serviceId, environmentId, mountPath: "/data" } });
    const volumeId = volume.volumeCreate.id;
    addLog(`Volume created: ${volumeId}`);

    addLog("Setting environment variables...");
    await railwayGql(VARIABLE_COLLECTION_UPSERT, {
      input: { projectId, environmentId, serviceId, variables: {
        SETUP_PASSWORD: finalSetupPassword, OPENCLAW_STATE_DIR: "/data/.openclaw",
        OPENCLAW_WORKSPACE_DIR: "/data/workspace", OPENCLAW_GATEWAY_TOKEN: gatewayToken,
        PORT: "8080", OPENCLAW_PUBLIC_PORT: "8080",
      }, replace: false },
    });
    addLog("Variables set.");

    let tailscaleHostname = null;
    if (isTailscaleConfigured()) {
      try {
        addLog("Generating Tailscale auth key...");
        const tsToken = await getTailscaleToken();
        const tsKey = await createAuthKey(tsToken, serviceSlug);
        await railwayGql(VARIABLE_COLLECTION_UPSERT, {
          input: { projectId, environmentId, serviceId, variables: { TS_AUTHKEY: tsKey.key, TS_HOSTNAME: serviceSlug }, replace: false },
        });
        tailscaleHostname = serviceSlug;
        addLog(`Tailscale key created. Device will join as "${serviceSlug}".`);
      } catch (e) { addLog(`Tailscale setup skipped: ${String(e)}`); }
    }

    addLog("Creating public domain...");
    try {
      const domainResult = await railwayGql(SERVICE_DOMAIN_CREATE, { input: { serviceId, environmentId } });
      addLog(`Domain: ${domainResult.serviceDomainCreate?.domain || "(pending)"}`);
    } catch (e) { addLog(`Domain creation note: ${String(e)}`); }

    addLog("Triggering deployment...");
    await railwayGql(SERVICE_INSTANCE_DEPLOY, { serviceId, environmentId });
    addLog("Deployment triggered. Build will take several minutes.");

    store.addInstance(def.id, {
      id: instanceId, name: cleanName, createdAt: new Date().toISOString(),
      railway: { projectId, serviceId, environmentId, volumeId },
      config: { setupPassword: finalSetupPassword, gatewayToken },
      tailscale: tailscaleHostname ? { hostname: tailscaleHostname } : null,
      notes: notes || "",
    });
    addLog("Instance saved to fleet store.");

    res.json({ ok: true, instance: { id: instanceId, name: cleanName, setupPassword: finalSetupPassword, railway: { projectId, serviceId, environmentId } }, log });
  } catch (err) {
    console.error("[fleet] create error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/api/instances/:id/restart", requireAuth, async (req, res) => {
  const found = store.findInstanceAcrossTenants(req.params.id);
  if (!found) return res.status(404).json({ ok: false, error: "Not found" });
  try {
    await railwayGql(SERVICE_INSTANCE_REDEPLOY, {
      serviceId: found.instance.railway.serviceId,
      environmentId: found.instance.railway.environmentId,
    });
    statusCache.delete(found.instance.id);
    res.json({ ok: true, message: "Redeployment triggered." });
  } catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
});

app.post("/api/instances/:id/redeploy", requireAuth, async (req, res) => {
  const found = store.findInstanceAcrossTenants(req.params.id);
  if (!found) return res.status(404).json({ ok: false, error: "Not found" });
  try {
    await railwayGql(SERVICE_INSTANCE_REDEPLOY, {
      serviceId: found.instance.railway.serviceId,
      environmentId: found.instance.railway.environmentId,
    });
    statusCache.delete(found.instance.id);
    res.json({ ok: true, message: "Redeployment triggered." });
  } catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
});

app.delete("/api/instances/:id", requireAuth, async (req, res) => {
  const found = store.findInstanceAcrossTenants(req.params.id);
  if (!found) return res.status(404).json({ ok: false, error: "Not found" });
  try {
    await railwayGql(PROJECT_DELETE, { id: found.instance.railway.projectId });
    store.removeInstance(found.tenant.id, found.instance.id);
    statusCache.delete(found.instance.id);
    res.json({ ok: true, message: `Deleted project for "${found.instance.name}".` });
  } catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
});

app.get("/api/instances/:id/health", requireAuth, async (req, res) => {
  const found = store.findInstanceAcrossTenants(req.params.id);
  if (!found) return res.status(404).json({ ok: false, error: "Not found" });
  try {
    const cached = statusCache.get(found.instance.id);
    const domain = cached?.data?.domain;
    if (!domain) return res.json({ ok: false, error: "Domain not yet available." });
    const hRes = await fetch(`https://${domain}/healthz`, { signal: AbortSignal.timeout(5000) });
    if (hRes.ok) { res.json({ ok: true, health: await hRes.json() }); }
    else { res.json({ ok: false, status: hRes.status }); }
  } catch (err) { res.json({ ok: false, error: String(err) }); }
});

// --- Start server ---

app.listen(PORT, "0.0.0.0", () => {
  const tenants = store.getAllTenants();
  const totalInstances = tenants.reduce((sum, t) => sum + t.instanceCount, 0);
  console.log(`[fleet] CortexAI Fleet Manager listening on :${PORT}`);
  console.log(`[fleet] GitHub repo: ${GITHUB_REPO}`);
  console.log(`[fleet] Tenants: ${tenants.length}, Instances: ${totalInstances}`);
});

// --- Dashboard HTML ---

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CortexAI Fleet Manager</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0; padding: 2rem;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #0a0a0a; color: #e2e8f0;
      line-height: 1.6;
    }
    h1 { color: #FF6B35; margin-top: 0; }
    h2 { color: #FF6B35; margin-top: 0; font-size: 1.1rem; }
    .muted { color: #94a3b8; font-size: 0.9rem; }
    .card {
      background: #141414; border: 1px solid #2a2a2a; border-radius: 12px;
      padding: 1.5rem; margin-bottom: 1rem;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }
    button {
      padding: 0.5rem 1rem; border: none; border-radius: 6px;
      cursor: pointer; font-size: 0.9rem; color: #fff;
      transition: opacity 0.2s;
    }
    button:hover { opacity: 0.85; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: linear-gradient(135deg, #FF6B35, #E85D2E); font-weight: 700; }
    .btn-secondary { background: #1a1a1a; color: #FF6B35; border: 1px solid #FF6B35; font-weight: 700; }
    .btn-danger { background: #7f1d1d; }
    .btn-muted { background: #333; }
    input, select {
      width: 100%; padding: 0.6rem; margin: 0.25rem 0 0.75rem 0;
      background: #1a1a1a; color: #e2e8f0; border: 1px solid #3a3a3a;
      border-radius: 8px; font-size: 0.95rem;
    }
    label { display: block; color: #FF6B35; font-weight: 600; font-size: 0.85rem; margin-top: 0.5rem; }
    pre {
      background: #111; padding: 0.75rem; border-radius: 8px;
      overflow-x: auto; font-size: 0.85rem; color: #94a3b8;
      white-space: pre-wrap; max-height: 300px; overflow-y: auto;
    }
    .status-dot {
      display: inline-block; width: 10px; height: 10px;
      border-radius: 50%; margin-right: 0.4rem; vertical-align: middle;
    }
    .status-running { background: #4ade80; }
    .status-needs-setup { background: #facc15; }
    .status-building, .status-deploying { background: #60a5fa; }
    .status-failed { background: #f87171; }
    .status-unhealthy { background: #fb923c; }
    .status-stopped, .status-unknown, .status-no-deployment { background: #6b7280; }
    .tenant-grid, .instance-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem; }
    .tenant-card {
      background: #141414; border: 1px solid #2a2a2a; border-radius: 12px;
      padding: 1.25rem; cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      transition: border-color 0.2s;
    }
    .tenant-card:hover { border-color: #FF6B35; }
    .tenant-card h3 { margin: 0 0 0.5rem 0; color: #FF6B35; font-size: 1.1rem; }
    .instance-card {
      background: #141414; border: 1px solid #2a2a2a; border-radius: 12px;
      padding: 1.25rem;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }
    .instance-card h3 { margin: 0 0 0.5rem 0; color: #e2e8f0; font-size: 1rem; }
    .instance-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.75rem; }
    .instance-actions button { font-size: 0.8rem; padding: 0.35rem 0.75rem; }
    .breadcrumb { margin-bottom: 1rem; font-size: 0.95rem; }
    .breadcrumb a { color: #FF6B35; text-decoration: none; cursor: pointer; }
    .breadcrumb a:hover { text-decoration: underline; }
    .breadcrumb .sep { color: #94a3b8; margin: 0 0.5rem; }
    .instance-count { color: #4ade80; font-weight: 600; }
    @media (max-width: 600px) {
      body { padding: 1rem; }
      .tenant-grid, .instance-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <h1>CortexAI Fleet Manager</h1>
  <p class="muted">Create and manage CortexAI Assistant instances on Railway.</p>

  <!-- Breadcrumb navigation -->
  <div class="breadcrumb" id="breadcrumb">
    <a id="breadcrumbRoot" onclick="fleetActions.showTenants()">All Tenants</a>
    <span class="sep" id="breadcrumbSep" style="display:none">/</span>
    <span id="breadcrumbTenant" style="display:none"></span>
  </div>

  <!-- Toolbar -->
  <div style="margin-bottom: 1rem; display: flex; gap: 0.5rem;">
    <button class="btn-primary" id="showCreate">New Tenant</button>
    <button class="btn-secondary" id="refreshAll">Refresh</button>
  </div>

  <!-- Create tenant form (hidden by default) -->
  <div class="card" id="createTenantPanel" style="display:none">
    <h2>Create New Tenant</h2>
    <label>Tenant name (client name)</label>
    <input id="createTenantName" placeholder="e.g. Client XYZ" maxlength="50" />
    <label>Notes (optional)</label>
    <input id="createTenantNotes" placeholder="Internal notes about this client" />
    <div style="margin-top: 0.5rem; display: flex; gap: 0.5rem;">
      <button class="btn-primary" id="createTenantRun">Create Tenant</button>
      <button class="btn-muted" id="createTenantCancel">Cancel</button>
    </div>
  </div>

  <!-- Create instance form (hidden by default) -->
  <div class="card" id="createPanel" style="display:none">
    <h2>Create New Instance</h2>
    <label>Instance name</label>
    <input id="createName" placeholder="e.g. Client Alpha" maxlength="50" />
    <label>Setup password (auto-generated if blank)</label>
    <input id="createPassword" placeholder="Leave blank to auto-generate" />
    <label>Notes (optional)</label>
    <input id="createNotes" placeholder="Internal notes about this instance" />
    <div style="margin-top: 0.5rem; display: flex; gap: 0.5rem;">
      <button class="btn-primary" id="createRun">Create Instance</button>
      <button class="btn-muted" id="createCancel">Cancel</button>
    </div>
    <pre id="createLog" style="display:none"></pre>
  </div>

  <!-- Tenants list (shown on tenant view) -->
  <div id="tenantsList">
    <p class="muted">Loading tenants...</p>
  </div>

  <!-- Instances list (shown on instance view, hidden by default) -->
  <div id="instancesList" style="display:none">
    <p class="muted">Loading instances...</p>
  </div>

  <script src="/app.js"></script>
</body>
</html>`;
