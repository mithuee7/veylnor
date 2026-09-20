import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await req.json();
    const name = String(body?.name ?? "").trim();
    if (!name || name.length > 60) return NextResponse.json({ error: "Enter a category name (1–60 characters)." }, { status: 400 });
    const { data: current, error: currentError } = await supabaseServer.from("clip_categories").select("id,name").eq("id", params.id).single();
    if (currentError || !current) return NextResponse.json({ error: "Category not found." }, { status: 404 });
    const { data: duplicate } = await supabaseServer.from("clip_categories").select("id").ilike("name", name).neq("id", params.id).maybeSingle();
    if (duplicate) return NextResponse.json({ error: "A clip category with that name already exists." }, { status: 409 });
    const { error: clipsError } = await supabaseServer.from("clips").update({ category: name }).eq("category", current.name);
    if (clipsError) return NextResponse.json({ error: `Could not update clips: ${clipsError.message}` }, { status: 500 });
    const { data, error } = await supabaseServer.from("clip_categories").update({ name }).eq("id", params.id).select("id,name,created_at").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ category: data });
  } catch (e: any) { return NextResponse.json({ error: e?.message ?? "Could not rename category." }, { status: 500 }); }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { data: category, error: lookupError } = await supabaseServer.from("clip_categories").select("id,name").eq("id", params.id).single();
    if (lookupError || !category) return NextResponse.json({ error: "Category not found." }, { status: 404 });
    const { data: clips, error: clipsError } = await supabaseServer.from("clips").select("id,storage_path").eq("category", category.name);
    if (clipsError) return NextResponse.json({ error: clipsError.message }, { status: 500 });
    const paths = (clips ?? []).map((clip) => clip.storage_path).filter(Boolean);
    for (let i = 0; i < paths.length; i += 100) {
      const { error: storageError } = await supabaseServer.storage.from("clips").remove(paths.slice(i, i + 100));
      if (storageError) return NextResponse.json({ error: `Could not delete media files (batch ${Math.floor(i / 100) + 1}). ${storageError.message}` }, { status: 500 });
    }
    const { error: deleteClipsError } = await supabaseServer.from("clips").delete().eq("category", category.name);
    if (deleteClipsError) return NextResponse.json({ error: `Storage was cleaned, but clip database cleanup failed: ${deleteClipsError.message}` }, { status: 500 });
    const { error: deleteCategoryError } = await supabaseServer.from("clip_categories").delete().eq("id", category.id);
    if (deleteCategoryError) return NextResponse.json({ error: deleteCategoryError.message }, { status: 500 });
    return NextResponse.json({ deleted: true, clipsDeleted: clips?.length ?? 0 });
  } catch (e: any) { return NextResponse.json({ error: e?.message ?? "Could not delete category." }, { status: 500 }); }
}
