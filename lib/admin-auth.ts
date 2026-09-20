import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "veylnor_admin_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;

function secret() {
  return process.env.VEYNLOR_ADMIN_SESSION_SECRET || process.env.VEYNLOR_API_KEY || "";
}

function sign(value: string) {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export function createAdminSessionToken() {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ admin: true, exp })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function isAdminAuthenticated(req: NextRequest) {
  const configured = Boolean(process.env.VEYNLOR_ADMIN_PASSWORD && secret());
  if (!configured) return false;

  const token = req.cookies.get(COOKIE_NAME)?.value ?? "";
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return false;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed?.admin === true && Number(parsed.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function setAdminSessionCookie(response: NextResponse) {
  response.cookies.set({
    name: COOKIE_NAME,
    value: createAdminSessionToken(),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearAdminSessionCookie(response: NextResponse) {
  response.cookies.set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export function adminAuthConfigError() {
  if (!process.env.VEYNLOR_ADMIN_PASSWORD) return "VEYNLOR_ADMIN_PASSWORD is not configured.";
  if (!secret()) return "VEYNLOR_ADMIN_SESSION_SECRET is not configured.";
  return null;
}
