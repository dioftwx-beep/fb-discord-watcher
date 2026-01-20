// watcher.js
// FB Page -> Discord Watcher (ESM)
// - Fetches latest Page posts
// - Sends NEW posts to Discord with image embeds
// - Stores last_post_id in state.json

import { readFileSync, writeFileSync } from "fs";

const FB_PAGE_ID = process.env.FB_PAGE_ID;
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const STATE_FILE = "state.json";
const POSTS_LIMIT = parseInt(process.env.POSTS_LIMIT || "5", 10);

// ---------- helpers ----------

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing env: ${name}`);
  }
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { last_post_id: null };
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fbFetch(path) {
  const url = `https://graph.facebook.com/v24.0/${path}`;
  const res = await fetch(url);
  const text = await res.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`FB HTTP ${res.status}: Non-JSON response`);
  }

  if (!res.ok || json.error) {
    throw new Error(`FB HTTP ${res.status}: ${JSON.stringify(json)}`);
  }

  return json;
}

function pickImageFromPost(post) {
  // 1️⃣ classic photo post
  if (post.full_picture) return post.full_picture;

  // 2️⃣ attachment image
  const att = post.attachments?.data?.[0];
  const direct = att?.media?.image?.src;
  if (direct) return direct;

  // 3️⃣ carousel / multi-photo
  const sub = att?.subattachments?.data?.[0]?.media?.image?.src;
  if (sub) return sub;

  return null;
}

function cleanText(s) {
  return s ? String(s).trim() : "";
}

async function sendToDiscord({ title, url, description, imageUrl, timestamp }) {
  const payload = {
    username: "Spidey Bot",
    content: "New Facebook Page post",
    embeds: [
      {
        title,
        url,
        description,
        timestamp,
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

// ---------- main ----------

async function main() {
  requireEnv("FB_PAGE_ID", FB_PAGE_ID);
  requireEnv("FB_PAGE_ACCESS_TOKEN", FB_PAGE_ACCESS_TOKEN);
  requireEnv("DISCORD_WEBHOOK_URL", DISCORD_WEBHOOK_URL);

  const state = loadState();

  const fields = [
    "id",
    "message",
    "created_time",
    "permalink_url",
    "full_picture",
    "attachments{media,type,subattachments{media}}",
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

  // první běh – jen uložíme state
  if (!state.last_post_id) {
    state.last_post_id = posts[0].id;
    saveState(state);
    console.log("Initialized state. No notification sent.");
    return;
  }

  // nové posty
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

  // posílat od nejstaršího
  newPosts.reverse();

  for (const p of newPosts) {
    const url = p.permalink_url || `https://www.facebook.com/${p.id}`;
    const msg = cleanText(p.message);
    const imageUrl = pickImageFromPost(p);

    const title = msg
      ? msg.length > 80
        ? msg.slice(0, 77) + "…"
        : msg
      : "New Facebook post";

    await sendToDiscord({
      title,
      url,
      description: msg,
      imageUrl,
      timestamp: p.created_time,
    });

    console.log(`Sent: ${p.id}`);
  }

  state.last_post_id = newPosts[newPosts.length - 1].id;
  saveState(state);
  console.log("State updated.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
