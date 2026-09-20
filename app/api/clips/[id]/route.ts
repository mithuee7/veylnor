import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await req.json();
    const updates: { category?: string; filename?: string } = {};

    if (body?.category !== undefined) {
      const category = String(body.category ?? "").trim();
      if (!category) return NextResponse.json({ error: "A category is required." }, { status: 400 });
      const { data: valid } = await supabaseServer.from("clip_categories").select("id").eq("name", category).maybeSingle();
      if (!valid) return NextResponse.json({ error: "Invalid clip folder/category." }, { status: 400 });
      updates.category = category;
    }

    if (body?.filename !== undefined) {
      const filename = String(body.filename ?? "").trim();
      if (!filename) return NextResponse.json({ error: "A clip name is required." }, { status: 400 });
      if (filename.length > 240) return NextResponse.json({ error: "Clip name is too long." }, { status: 400 });
      updates.filename = filename;
    }

    if (!Object.keys(updates).length) return NextResponse.json({ error: "No clip changes were supplied." }, { status: 400 });

    const { data, error } = await supabaseServer
      .from("clips")
      .update(updates)
      .eq("id", params.id)
      .select("*")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ updated: true, clip: data });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Could not update clip." }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { data: clip, error: lookupError } = await supabaseServer
      .from("clips")
      .select("id,storage_path")
      .eq("id", params.id)
      .single();

    if (lookupError || !clip) return NextResponse.json({ error: "Clip not found." }, { status: 404 });

    const { error: deleteError } = await supabaseServer.from("clips").delete().eq("id", params.id);
    if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });

    const { error: storageError } = await supabaseServer.storage.from("clips").remove([clip.storage_path]);
    if (storageError) {
      return NextResponse.json({ deleted: true, warning: `Clip record deleted, but storage cleanup failed: ${storageError.message}` });
    }
    return NextResponse.json({ deleted: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Could not delete clip." }, { status: 500 });
  }
}
