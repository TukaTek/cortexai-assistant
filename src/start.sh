#!/bin/bash
set -e

# Ensure fallback DNS resolvers are present (Railway containers sometimes
# lack reliable DNS; Tailscale userspace networking can also interfere).
if ! grep -q '8.8.8.8' /etc/resolv.conf 2>/dev/null; then
  echo "nameserver 8.8.8.8" >> /etc/resolv.conf
  echo "nameserver 1.1.1.1" >> /etc/resolv.conf
  echo "[dns] Added fallback resolvers (8.8.8.8, 1.1.1.1)"
fi

# Start Tailscale if auth key is provided (opt-in).
if [ -n "$TS_AUTHKEY" ]; then
  echo "[tailscale] Starting tailscaled in userspace mode..."
  tailscaled --tun=userspace-networking --statedir=/data/tailscale --socket=/tmp/tailscaled.sock &
  sleep 2

  TS_HOSTNAME="${TS_HOSTNAME:-cortexai-instance}"
  echo "[tailscale] Joining tailnet as ${TS_HOSTNAME}..."
  tailscale --socket=/tmp/tailscaled.sock up --authkey="$TS_AUTHKEY" --hostname="$TS_HOSTNAME"

  # Expose the wrapper port to the tailnet.
  echo "[tailscale] Serving port ${PORT:-8080} on tailnet..."
  tailscale --socket=/tmp/tailscaled.sock serve --bg "${PORT:-8080}"

  echo "[tailscale] Connected. Accessible at https://${TS_HOSTNAME}/"
else
  echo "[tailscale] TS_AUTHKEY not set — Tailscale skipped."
fi

# Start the wrapper as the main process.
exec node src/server.js
