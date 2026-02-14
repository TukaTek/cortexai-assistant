// Tailscale API client for generating per-instance auth keys.
// Uses OAuth client credentials flow to create pre-authenticated keys.

const TAILSCALE_CLIENT_ID = process.env.TAILSCALE_CLIENT_ID || "";
const TAILSCALE_CLIENT_SECRET = process.env.TAILSCALE_CLIENT_SECRET || "";
const TAILSCALE_TAILNET = process.env.TAILSCALE_TAILNET || "-"; // "-" = default tailnet
const TAILSCALE_TAG = process.env.TAILSCALE_TAG || "tag:cortexai";

export function isTailscaleConfigured() {
  return Boolean(TAILSCALE_CLIENT_ID && TAILSCALE_CLIENT_SECRET);
}

/**
 * Get an OAuth access token from Tailscale.
 * @returns {Promise<string>} access token
 */
export async function getTailscaleToken() {
  const res = await fetch("https://api.tailscale.com/api/v2/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: TAILSCALE_CLIENT_ID,
      client_secret: TAILSCALE_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tailscale OAuth error ${res.status}: ${text}`);
  }

  const json = await res.json();
  return json.access_token;
}

/**
 * Create a pre-authenticated, non-reusable auth key for a new device.
 * @param {string} token - OAuth access token
 * @param {string} hostname - Desired hostname for the device
 * @returns {Promise<{ key: string, id: string }>}
 */
export async function createAuthKey(token, hostname) {
  const res = await fetch(
    `https://api.tailscale.com/api/v2/tailnet/${TAILSCALE_TAILNET}/keys`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        capabilities: {
          devices: {
            create: {
              reusable: false,
              ephemeral: false,
              preauthorized: true,
              tags: [TAILSCALE_TAG],
            },
          },
        },
        expirySeconds: 7776000, // 90 days (maximum)
        description: `Fleet: ${hostname}`,
      }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tailscale key creation error ${res.status}: ${text}`);
  }

  return res.json();
}
