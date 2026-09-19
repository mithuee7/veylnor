import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") ?? 120)));
  const offset = Math.max(0, Number(searchParams.get("offset") ?? 0));
  const category = searchParams.get("category");
  let clipsQuery = supabaseServer.from("clips").select("*", { count: "exact" });
  if (category) clipsQuery = clipsQuery.eq("category", category);
  const { data, error, count } = await clipsQuery
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Attach a signed, time-limited URL for each clip so the browser can
  // render thumbnails/previews without the bucket being public.
  const withUrls = await Promise.all(
    (data ?? []).map(async (clip) => {
      const { data: signed } = await supabaseServer.storage
        .from("clips")
        .createSignedUrl(clip.storage_path, 60 * 60);
      return { ...clip, url: signed?.signedUrl ?? null };
    })
  );

  return NextResponse.json({ clips: withUrls, hasMore: offset + withUrls.length < (count ?? 0), total: count ?? withUrls.length });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { filename, category, storage_path, duration } = body as {
    filename: string;
    category: string;
    storage_path: string;
    duration?: number | null;
  };

  if (!filename || !storage_path || !category) return NextResponse.json({ error: "Invalid clip payload" }, { status: 400 });
  const { data: validCategory } = await supabaseServer.from("clip_categories").select("id").eq("name", category).maybeSingle();
  if (!validCategory) return NextResponse.json({ error: "Invalid clip folder/category." }, { status: 400 });

  const { data, error } = await supabaseServer
    .from("clips")
    .insert({ filename, category, storage_path, duration: duration ?? null })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ clip: data });
}
