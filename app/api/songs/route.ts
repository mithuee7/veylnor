import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";

export async function GET(req: NextRequest) {
  const songsQuery = supabaseServer.from("songs").select("*").order("created_at", { ascending: false });
  const { data, error } = await songsQuery;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const withUrls = await Promise.all(
    (data ?? []).map(async (song) => {
      const { data: signed } = await supabaseServer.storage
        .from("songs")
        .createSignedUrl(song.storage_path, 60 * 60);
      return { ...song, url: signed?.signedUrl ?? null };
    })
  );

  return NextResponse.json({ songs: withUrls });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { filename, storage_path, duration } = body as {
    filename: string;
    storage_path: string;
    duration?: number | null;
  };

  if (!filename || !storage_path) {
    return NextResponse.json({ error: "Invalid song payload" }, { status: 400 });
  }

  const { data, error } = await supabaseServer
    .from("songs")
    .insert({ filename, storage_path, duration: duration ?? null })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ song: data });
}
