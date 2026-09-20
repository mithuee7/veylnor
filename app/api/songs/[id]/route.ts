import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { data: song, error: lookupError } = await supabaseServer
      .from("songs")
      .select("id,storage_path")
      .eq("id", params.id)
      .single();

    if (lookupError || !song) return NextResponse.json({ error: "Song not found." }, { status: 404 });

    const { error: deleteError } = await supabaseServer.from("songs").delete().eq("id", params.id);
    if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });

    const { error: storageError } = await supabaseServer.storage.from("songs").remove([song.storage_path]);
    if (storageError) {
      return NextResponse.json({ deleted: true, warning: `Song record deleted, but storage cleanup failed: ${storageError.message}` });
    }
    return NextResponse.json({ deleted: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Could not delete song." }, { status: 500 });
  }
}
