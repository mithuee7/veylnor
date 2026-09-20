import { NextRequest } from "next/server";

export function requireVeylnorApiKey(req: NextRequest) {
  const expected = process.env.VEYNLOR_API_KEY;
  if (!expected) {
    return { ok: false as const, status: 503, error: "VEYNLOR_API_KEY is not configured on the server." };
  }

  const authorization = req.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const supplied = bearer || req.headers.get("x-veylnor-api-key")?.trim();

  if (!supplied || supplied !== expected) {
    return { ok: false as const, status: 401, error: "Unauthorized." };
  }

  return { ok: true as const };
}
