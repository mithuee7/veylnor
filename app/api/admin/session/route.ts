import { NextRequest, NextResponse } from "next/server";
import { adminAuthConfigError, isAdminAuthenticated } from "@/lib/admin-auth";
export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  const configError = adminAuthConfigError();
  if (configError) return NextResponse.json({ authenticated: false, configured: false });
  return NextResponse.json({ authenticated: isAdminAuthenticated(req), configured: true });
}
