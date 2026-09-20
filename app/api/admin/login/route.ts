import { NextRequest, NextResponse } from "next/server";
import { adminAuthConfigError, setAdminSessionCookie } from "@/lib/admin-auth";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  const configError = adminAuthConfigError();
  if (configError) return NextResponse.json({ error: configError }, { status: 503 });
  let body: { password?: string } = {};
  try { body = await req.json(); } catch {}
  if (!body.password || body.password !== process.env.VEYNLOR_ADMIN_PASSWORD) {
    return NextResponse.json({ error: "Invalid admin password." }, { status: 401 });
  }
  const response = NextResponse.json({ authenticated: true });
  setAdminSessionCookie(response);
  return response;
}
