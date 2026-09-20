import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";

const MAX_LENGTH = 4000;

// reel_preferences was originally created with a UUID primary key. Do not
// compare that column to the integer 1; instead, treat the table as a
// singleton and update the one existing row (or create one if empty).
async function getPreferenceRow() {
  return supabaseServer
    .from("reel_preferences")
    .select("id,name,instructions,updated_at")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function GET() {
  try {
    const { data, error } = await getPreferenceRow();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ instructions: data?.instructions ?? "", updatedAt: data?.updated_at ?? null });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Could not load reel preferences." }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const instructions = String(body?.instructions ?? "").trim().slice(0, MAX_LENGTH);
    const existing = await getPreferenceRow();
    if (existing.error) return NextResponse.json({ error: existing.error.message }, { status: 500 });

    const updatedAt = new Date().toISOString();
    let data;
    let error;

    if (existing.data?.id) {
      ({ data, error } = await supabaseServer
        .from("reel_preferences")
        .update({ instructions, updated_at: updatedAt })
        .eq("id", existing.data.id)
        .select("instructions,updated_at")
        .single());
    } else {
      ({ data, error } = await supabaseServer
        .from("reel_preferences")
        .insert({ name: "default", instructions, updated_at: updatedAt })
        .select("instructions,updated_at")
        .single());
    }

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ instructions: data?.instructions ?? instructions, updatedAt: data?.updated_at ?? null });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Could not save reel preferences." }, { status: 500 });
  }
}
