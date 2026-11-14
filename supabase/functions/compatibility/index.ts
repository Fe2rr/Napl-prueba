const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, apikey, Authorization",
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
      ...headers,
    },
  });
}

function getBackendKey(): { key: string; legacy: boolean } {
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacyKey) return { key: legacyKey, legacy: true };

  const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeysRaw) {
    try {
      const keys = JSON.parse(secretKeysRaw);
      const key = keys?.default;
      if (typeof key === "string" && key) return { key, legacy: false };
    } catch {
      // Fall through to a clear configuration error.
    }
  }
  throw new Error("Supabase server key is not configured for this Edge Function.");
}

async function rpc(name: string, args: Record<string, unknown>) {
  const baseUrl = Deno.env.get("SUPABASE_URL");
  if (!baseUrl) throw new Error("SUPABASE_URL is not configured.");

  const { key, legacy } = getBackendKey();
  const headers: Record<string, string> = {
    "apikey": key,
    "Content-Type": "application/json",
  };
  if (legacy) headers.Authorization = `Bearer ${key}`;

  const response = await fetch(`${baseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
  });
  const raw = await response.text();
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error("Database returned an invalid response.");
  }
  if (!response.ok) {
    console.error("Compatibility database error:", response.status, data);
    throw new Error("Could not process compatibility data.");
  }
  return data;
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const url = new URL(request.url);

    if (request.method === "GET") {
      if (url.searchParams.get("action") === "devices") {
        const devices = await rpc("get_compatibility_devices", {});
        return json(
          { success: true, devices: Array.isArray(devices) ? devices : [] },
          200,
          { "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800" },
        );
      }

      const ids = Array.from(new Set(
        (url.searchParams.get("port_ids") || "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      )).slice(0, 50);

      if (ids.some((id) => id.length > 120)) {
        return json({ success: false, error: "Invalid port ID." }, 400);
      }
      if (!ids.length) return json({ success: true, compatibility: {} });

      const result = await rpc("get_compatibility_for_ports", {
        p_port_ids: ids,
      });
      return json(
        { success: true, compatibility: result || {} },
        200,
        { "Cache-Control": "public, max-age=30, s-maxage=60" },
      );
    }

    if (request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return json({ success: false, error: "Invalid JSON body." }, 400);
      }

      const portId = String(body.port_id || "").trim();
      const deviceId = String(body.device_id || "").trim();
      const token = String(body.token || "").trim();
      const works = typeof body.works === "boolean"
        ? body.works
        : body.works === 1 ? true : body.works === 0 ? false : null;

      if (!portId || portId.length > 120 || !deviceId || deviceId.length > 200 ||
          !token || token.length > 512 || works === null) {
        return json({
          success: false,
          error: "port_id, device_id, token, and works (boolean) are required.",
        }, 400);
      }

      const tokenHash = await hashToken(token);
      const saved = await rpc("upsert_compatibility_report", {
        p_port_id: portId,
        p_token_hash: tokenHash,
        p_device_id: deviceId,
        p_works: works,
      });

      return json({
        success: true,
        report: saved?.report || null,
        summary: saved?.summary || null,
      }, 200, { "Cache-Control": "no-store" });
    }

    return json({ success: false, error: "Method not allowed." }, 405);
  } catch (error) {
    console.error("Compatibility function error:", error);
    return json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error.",
    }, 500);
  }
});
