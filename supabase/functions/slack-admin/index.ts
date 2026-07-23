import { createClient } from "npm:@supabase/supabase-js@2";

// Short-lived admin helper (deleted right after use). Gated by a one-off key in the query.
const KEY = "tja-slack-setup-9c1f";

async function listChannels(token: string) {
  const out: Array<{ id: string; name: string }> = [];
  let cursor = "";
  for (let i = 0; i < 20; i++) {
    const u = new URL("https://slack.com/api/conversations.list");
    u.searchParams.set("types", "public_channel,private_channel");
    u.searchParams.set("limit", "1000");
    u.searchParams.set("exclude_archived", "true");
    if (cursor) u.searchParams.set("cursor", cursor);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    if (!j.ok) return { error: j.error, got: out };
    for (const c of j.channels || []) out.push({ id: c.id, name: c.name });
    cursor = j.response_metadata?.next_cursor || "";
    if (!cursor) break;
  }
  return { channels: out };
}

async function post(token: string, channel: string, text: string) {
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: channel.replace(/^#/, ""), text, unfurl_links: false }),
  });
  return await r.json();
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("key") !== KEY) return new Response("nope", { status: 401 });
  const token = Deno.env.get("SLACK_BOT_TOKEN")!;
  const op = url.searchParams.get("op") || "channels";
  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const J = (o: unknown) => new Response(JSON.stringify(o, null, 2), { headers: { "Content-Type": "application/json" } });

  if (op === "channels") {
    return J(await listChannels(token));
  }

  if (op === "celtic") {
    // set Celtic Elevator's channel + fire a live test post
    const { data } = await svc.from("app_state").select("data").eq("client_id", "_registry").eq("scope", "clients").maybeSingle();
    const roster: any[] = Array.isArray(data?.data) ? data!.data : [];
    const c = roster.find((x) => x.id === "celtic-elevator" || /celtic/i.test(x.name || ""));
    if (!c) return J({ error: "celtic client not found", ids: roster.map((x) => x.id) });
    c.integrations = c.integrations || {};
    c.integrations.slackChannel = "#client-celtic-elevator";
    await svc.from("app_state").update({ data: roster, updated_at: new Date().toISOString() })
      .eq("client_id", "_registry").eq("scope", "clients");
    const test = await post(token, "#client-celtic-elevator",
      "🔔 *TJA portal test* — Slack notifications for *Celtic Elevator* are live. Deliverable sends and client reviews will post here.");
    return J({ set: c.id, channel: c.integrations.slackChannel, post_result: test });
  }

  if (op === "bulk") {
    // match #client-<slug> channels to clients by id / slugified name
    const { channels, error } = await listChannels(token);
    if (error) return J({ error });
    const { data } = await svc.from("app_state").select("data").eq("client_id", "_registry").eq("scope", "clients").maybeSingle();
    const roster: any[] = Array.isArray(data?.data) ? data!.data : [];
    const slug = (s: string) => String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const clientChans = (channels || []).filter((ch) => /^client-/.test(ch.name)).map((ch) => ({ ...ch, slug: ch.name.replace(/^client-/, "") }));
    const matched: any[] = [], unmatched: any[] = [];
    for (const ch of clientChans) {
      const hit = roster.find((c) => c.id === ch.slug || slug(c.name) === ch.slug);
      if (hit) matched.push({ client: hit.id, name: hit.name, channel: "#" + ch.name });
      else unmatched.push("#" + ch.name);
    }
    const commit = url.searchParams.get("commit") === "1";
    if (commit) {
      for (const m of matched) {
        const c = roster.find((x) => x.id === m.client);
        c.integrations = c.integrations || {};
        c.integrations.slackChannel = m.channel;
      }
      await svc.from("app_state").update({ data: roster, updated_at: new Date().toISOString() })
        .eq("client_id", "_registry").eq("scope", "clients");
    }
    const clientsNoChannel = roster.filter((c) => !c.integrations?.slackChannel && !matched.find((m) => m.client === c.id))
      .map((c) => ({ id: c.id, name: c.name }));
    return J({ committed: commit, matched_count: matched.length, matched, unmatched_channels: unmatched, clients_without_a_channel: clientsNoChannel });
  }

  return J({ error: "unknown op" });
});
