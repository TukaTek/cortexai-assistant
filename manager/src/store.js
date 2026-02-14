// File-based persistence for fleet instance metadata.
// Stores data in /data/fleet.json with atomic writes and timestamped backups.
//
// Data model v2: tenants → instances (nested).
// Auto-migrates v1 (flat instances) to v2 on first load.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = process.env.DATA_DIR || "/data";
const STORE_PATH = path.join(DATA_DIR, "fleet.json");

function emptyStore() {
  const id = crypto.randomUUID();
  return {
    version: 2,
    tenants: {
      [id]: {
        id,
        name: "Default",
        slug: "default",
        createdAt: new Date().toISOString(),
        notes: "",
        tailscale: null,
        instances: {},
      },
    },
  };
}

export function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
}

// --- Migration ---

function migrateV1toV2(data) {
  if (data.version >= 2) return data;

  console.log("[store] Migrating fleet data from v1 to v2...");

  const defaultTenantId = crypto.randomUUID();
  return {
    version: 2,
    tenants: {
      [defaultTenantId]: {
        id: defaultTenantId,
        name: "Default",
        slug: "default",
        createdAt: new Date().toISOString(),
        notes: "Auto-created during migration from v1. Contains pre-existing instances.",
        tailscale: null,
        instances: data.instances || {},
      },
    },
  };
}

// --- Read / Write ---

export function load() {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    let data = JSON.parse(raw);

    // Auto-migrate v1 → v2.
    if (!data.version || data.version < 2) {
      // Backup before migration.
      const bakPath = path.join(DATA_DIR, "fleet.bak-premigrate.json");
      try {
        fs.copyFileSync(STORE_PATH, bakPath);
        console.log(`[store] Pre-migration backup: ${bakPath}`);
      } catch { /* best-effort */ }

      data = migrateV1toV2(data);
      save(data);
      console.log("[store] Migration complete.");
    }

    return data;
  } catch {
    const data = emptyStore();
    save(data);
    console.log("[store] Initialized new fleet store with Default tenant.");
    return data;
  }
}

export function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Create timestamped backup if file exists.
  if (fs.existsSync(STORE_PATH)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const bakPath = path.join(DATA_DIR, `fleet.bak-${ts}.json`);
    try {
      fs.copyFileSync(STORE_PATH, bakPath);
    } catch {
      // Best-effort backup.
    }
  }

  // Atomic write: write to tmp, rename over original.
  const tmpPath = STORE_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, STORE_PATH);
}

// --- Tenant CRUD ---

export function getAllTenants() {
  const data = load();
  return Object.values(data.tenants || {}).map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    createdAt: t.createdAt,
    notes: t.notes,
    tailscale: t.tailscale || null,
    instanceCount: Object.keys(t.instances || {}).length,
  }));
}

export function getTenant(tenantId) {
  const data = load();
  return data.tenants[tenantId] || null;
}

export function addTenant(tenant) {
  const data = load();
  if (!tenant.instances) tenant.instances = {};
  data.tenants[tenant.id] = tenant;
  save(data);
  return tenant;
}

export function updateTenant(tenantId, patch) {
  const data = load();
  if (!data.tenants[tenantId]) return null;
  // Only update metadata fields, not instances.
  const { instances: _ignored, ...safePatch } = patch;
  Object.assign(data.tenants[tenantId], safePatch);
  save(data);
  return data.tenants[tenantId];
}

export function removeTenant(tenantId) {
  const data = load();
  const removed = data.tenants[tenantId] || null;
  delete data.tenants[tenantId];
  save(data);
  return removed;
}

export function getDefaultTenant() {
  const data = load();
  return Object.values(data.tenants).find((t) => t.slug === "default") || null;
}

// --- Instance CRUD (tenant-scoped) ---

export function getAllInstances(tenantId) {
  const tenant = getTenant(tenantId);
  if (!tenant) return [];
  return Object.values(tenant.instances || {});
}

export function getInstance(tenantId, instanceId) {
  const tenant = getTenant(tenantId);
  if (!tenant) return null;
  return tenant.instances[instanceId] || null;
}

export function addInstance(tenantId, instance) {
  const data = load();
  if (!data.tenants[tenantId]) return null;
  if (!data.tenants[tenantId].instances) data.tenants[tenantId].instances = {};
  data.tenants[tenantId].instances[instance.id] = instance;
  save(data);
  return instance;
}

export function updateInstance(tenantId, instanceId, patch) {
  const data = load();
  const tenant = data.tenants[tenantId];
  if (!tenant || !tenant.instances[instanceId]) return null;
  Object.assign(tenant.instances[instanceId], patch);
  save(data);
  return tenant.instances[instanceId];
}

export function removeInstance(tenantId, instanceId) {
  const data = load();
  const tenant = data.tenants[tenantId];
  if (!tenant) return null;
  const removed = tenant.instances[instanceId] || null;
  delete tenant.instances[instanceId];
  save(data);
  return removed;
}

// --- Cross-tenant helpers ---

export function findInstanceAcrossTenants(instanceId) {
  const data = load();
  for (const tenant of Object.values(data.tenants)) {
    if (tenant.instances && tenant.instances[instanceId]) {
      return { tenant, instance: tenant.instances[instanceId] };
    }
  }
  return null;
}
