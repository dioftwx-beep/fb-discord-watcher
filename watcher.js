// watcher.js
// FB Page -> Discord Watcher
// - Fetches latest Page posts via Graph API
// - Sends NEW posts to Discord with an embed (includes image when available)
// - Stores last_post_id in state.json

const fs = require("fs");

const FB_PAGE_ID = process.env.FB_PAGE_ID;
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const STATE_FILE = "state.json";
const POSTS_LIMIT = parseInt(process.env.POSTS_LIMIT || "5", 10);

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing env: ${name}`);
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { last_post_id: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fbFetch(path) {
  const url = `https://graph.facebook.com/v24.0/${path}`;
  const res = await fetch(url);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`FB HTTP ${res.status}: Non-JSON response: ${text.slice(0, 200)}`);
  }
  if (!res.ok || json.error) {
    throw new Error(`FB HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function pickImageFromPost(post) {
  // Best effort:
  // 1) full_picture (often works for photo posts)
  // 2) attachments.media.image.src
  // 3) attachments.subattachments[].media.image.src
  if (post.full_picture) return post.full_picture;

  const att = post.attachments?.data?.[0];
  const direct = att?.media?.image?.src;
  if (direct) return direct;

  const sub = att?.subattachments?.data?.[0]?.media?.image?.src;
  if (sub) return sub;

  return null;
}

function cleanText(s) {
  if (!s) return "";
  return String(s).trim();
}

async function sendToDiscord({ title, url, description, imageUrl, timestamp }) {
  // Discord embed
  const payload = {
    username: "Spidey Bot",
    content: "New Facebook Page post",
    embeds: [
      {
        title: title || "New post",
        url,
        description: description?.slice(0, 3500) || "",
        timestamp: timestamp || new Date().toISOString(),
      },
    ],
  };

  if (imageUrl) {
    payload.embeds[0].image = { url: imageUrl };
  }

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord HTTP ${res.status}: ${body}`);
  }
}

async function main() {
  requireEnv("FB_PAGE_ID", FB_PAGE_ID);
  requireEnv("FB_PAGE_ACCESS_TOKEN", FB_PAGE_ACCESS_TOKEN);
  requireEnv("DISCORD_WEBHOOK_URL", DISCORD_WEBHOOK_URL);

  const state = loadState();

  // Fetch latest posts with fields that include image URLs
  const fields = [
    "id",
    "message",
    "created_time",
    "permalink_url",
    "full_picture",
    "attachments{media,type,url,subattachments{media}}",
  ].join(",");

  const postsResp = await fbFetch(
    `${FB_PAGE_ID}/posts?fields=${encodeURIComponent(fields)}&limit=${POSTS_LIMIT}&access_token=${encodeURIComponent(
      FB_PAGE_ACCESS_TOKEN
    )}`
  );

  const posts = postsResp.data || [];
  console.log(`DEBUG: posts fetched = ${posts.length}`);
  console.log(`DEBUG: last_post_id(state) = ${state.last_post_id}`);

  if (posts.length === 0) {
    console.log("No posts found.");
    return;
  }

  // If first run, initialize state to newest post
  if (!state.last_post_id) {
    state.last_post_id = posts[0].id;
    saveState(state);
    console.log("Initialized state. No notification sent.");
    return;
  }

  // Find new posts until we hit last_post_id
  const newPosts = [];
  for (const p of posts) {
    if (p.id === state.last_post_id) break;
    newPosts.push(p);
  }

  console.log(`DEBUG: new posts to send = ${newPosts.length}`);
  if (newPosts.length === 0) {
    console.log("No new items.");
    return;
  }

  // Send oldest -> newest
  newPosts.reverse();

  for (const p of newPosts) {
    const url = p.permalink_url || `https://www.facebook.com/${p.id}`;
    const msg = cleanText(p.message);
    const imageUrl = pickImageFromPost(p);

    // Title: if message empty, use page name-ish
    const title = msg ? (msg.length > 80 ? msg.slice(
