import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";

// Returns a short-lived signed URL the browser can upload a single file to
// directly. Keeps the service-role key on the server.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { kind, filename, category } = body as {
    kind: "clip" | "song";
    filename: string;
    category?: string;
  };

  if (!filename || (kind !== "clip" && kind !== "song")) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const bucket = kind === "clip" ? "clips" : "songs";
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  let folder = "";
  if (kind === "clip") {
    if (!category) return NextResponse.json({ error: "A clip folder/category is required." }, { status: 400 });
    const { data: validCategory } = await supabaseServer.from("clip_categories").select("id").eq("name", category).maybeSingle();
    if (!validCategory) return NextResponse.json({ error: "Invalid clip folder/category." }, { status: 400 });
    folder = category.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  }
  const path = `${folder ? folder + "/" : ""}${Date.now()}-${safeName}`;

  const { data, error } = await supabaseServer.storage
    .from(bucket)
    .createSignedUploadUrl(path);

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Could not create upload URL" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    signedUrl: data.signedUrl,
    token: data.token,
    path: data.path,
    bucket,
  });
}
