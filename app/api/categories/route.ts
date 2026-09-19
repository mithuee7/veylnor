import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";

export async function GET() {
  const { data, error } = await supabaseServer.from("clip_categories").select("id,name,created_at").order("name", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ categories: data ?? [] });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body?.name ?? "").trim();
    if (!name || name.length > 60) return NextResponse.json({ error: "Enter a category name (1–60 characters)." }, { status: 400 });
    const { data: duplicate } = await supabaseServer.from("clip_categories").select("id").ilike("name", name).maybeSingle();
    if (duplicate) return NextResponse.json({ error: "A clip category with that name already exists." }, { status: 409 });
    const { data, error } = await supabaseServer.from("clip_categories").insert({ name }).select("id,name,created_at").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ category: data }, { status: 201 });
  } catch (e: any) { return NextResponse.json({ error: e?.message ?? "Could not create category." }, { status: 500 }); }
}
