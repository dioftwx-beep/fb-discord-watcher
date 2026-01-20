import fetch from "node-fetch";
import fs from "fs";

const FB_PAGE_ID = process.env.FB_PAGE_ID;
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const STATE_FILE = "state.json";
const MAX_POSTS = 5;

function mustEnv(name, val) {
  if (!val) throw new Error(`Missing env: ${name}`);
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { last_post_id: null };
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { last_post_id: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function pickBestText(post) {
  if (post.message && post.message.trim()) return post.message.trim();
  if (post.story && post.story.trim()) return post.story.trim();
  return "(No text)";
}

async function fbFetch(url) {
  const res = await fetch(url, { redirect: "follow" });
  const text = await res.text();
  if (!res.ok) throw new Error(`FB HTTP ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  if (json.error) throw new Error(`FB API error: ${JSON.stringify(json.error)}`);
  return json;
}

async function discordSend(post) {
  const title = "New Facebook Page post";
  const text = pickBestText(post);
  const link = post.permalink_url || "";
  const image = post.full_picture || null;

  // Discord webhook payload (simple + embed)
  const payload = {
    content: `${title}\n${link}`.trim(),
    embeds: [
      {
        description: text.length > 1800 ? text.slice(0, 1800) + "…" : text,
        url: link || undefined,
        image: image ? { url: image } : undefined,
        timestamp: post.created_time || undefined
      }
    ]
  };

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`Discord HTTP ${res.status}: ${body.slice(0, 300)}`);
}

async function main() {
  mustEnv("FB_PAGE_ID", FB_PAGE_ID);
  mustEnv("FB_PAGE_ACCESS_TOKEN", FB_PAGE_ACCESS_TOKEN);
  mustEnv("DISCORD_WEBHOOK_URL", DISCORD_WEBHOOK_URL);

  const state = loadState();

  // Get last posts from the Page feed
  const fields = [
    "id",
    "message",
    "story",
    "created_time",
    "permalink_url",
    "full_picture"
  ].join(",");

  const url =
    `https://graph.facebook.com/v24.0/${encodeURIComponent(FB_PAGE_ID)}/posts` +
    `?fields=${encodeURIComponent(fields)}` +
    `&limit=${MAX_POSTS}` +
    `&access_token=${encodeURIComponent(FB_PAGE_ACCESS_TOKEN)}`;

  const data = await fbFetch(url);
  const posts = Array.isArray(data?.data) ? data.data : [];

  console.log(`DEBUG: posts fetched = ${posts.length}`);
  console.log(`DEBUG: last_post_id (state) = ${state.last_post_id}`);

  if (!posts.length) {
    console.log("No posts returned.");
    return;
  }

  // posts are usually newest first
  const newest = posts[0];

  if (!state.last_post_id) {
    // First run: just save newest id (no spam)
    state.last_post_id = newest.id;
    saveState(state);
    console.log("Initialized state. No notification sent.");
    return;
  }

  if (newest.id === state.last_post_id) {
    console.log("No new post.");
    return;
  }

  // Find all posts that are newer than last_post_id in this batch
  // (In case multiple new posts arrived between runs)
  const newOnes = [];
  for (const p of posts) {
    if (p.id === state.last_post_id) break;
    newOnes.push(p);
  }

  // Send oldest -> newest to keep order
  newOnes.reverse();

  console.log(`DEBUG: new posts to send = ${newOnes.length}`);

  for (const p of newOnes) {
    await discordSend(p);
    console.log(`Sent: ${p.id}`);
  }

  // Update state to newest
  state.last_post_id = newest.id;
  saveState(state);
  console.log("State updated.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
