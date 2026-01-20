// watcher.js (ESM)
// FB Page -> Discord Watcher
// - Fetches latest Page posts via Graph API
// - Sends NEW posts to Discord with an embed (includes image when available)
// - Stores last_post_id in state.json

import fs from "fs";

const FB_PAGE_ID = process.env.FB_PAGE_ID;
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const STATE_FILE = "state.json";
const POSTS_LIMIT = parseInt(process.env.POSTS_LIMIT || "5", 10);

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env: ${name}`);
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
    throw new Error(
      `FB HTTP ${res.status}: Non-JSON response: ${text.slice(0, 250)}`
    );
  }

  if (!res.ok || json.error) {
    throw new Error(`FB HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function cleanText(s) {
  if (!s) return "";
  return String(s).trim();
}

function pickImageFromPost(post) {
  // 1) classic photo post usually has this
  if (post.full_picture) return post.full_picture;

  const att0 = post.attachments?.data?.[0];
  if (!att0) return null;

  // 2) direct attachment image
  const direct = att0?.media?.image?.src;
  if (direct) return direct;

  // 3) multi-photo / albums / some shares
  const subs = att0?.subattachments?.data || [];
  for (const s of subs) {
    const subImg = s?.media?.image?.src;
    if (subImg) return subImg;
  }

  // 4) sometimes share previews hide it; best effort ends here
  return null;
}

function buildTitleFromMessage(msg) {
  if (!msg) return "New Facebook Page post";
  const oneLine = msg.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? oneLine.slice(0, 77) + "..." : oneLine;
}

async function sendToDiscord({ title, url, description, imageUrl, timestamp }) {
  const embed = {
    title: title || "New post",
    url,
    description: (description || "").slice(0, 3500),
    timestamp: timestamp || new Date().toISOString(),
  };

  if (imageUrl) {
    embed.image = { url: imageUrl };
  }

  const payload = {
    username: "Spidey Bot",
    content: "New Facebook Page post",
    embeds: [embed],
  };

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

  // First run: initialize state to newest post to avoid spamming old posts
  if (!state.last_post_id) {
    state.last_post_id = posts[0].id;
    saveState(state);
    console.log("Initialized state. No notification sent.");
    return;
  }

  // Collect posts newer than last_post_id
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
    const title = buildTitleFromMessage(msg);
    const imageUrl = pickImageFromPost(p);

    console.log(
      `DEBUG: sending post=${p.id} hasImage=${imageUrl ? "yes" : "no"}`
    );

    await sendToDiscord({
      title,
      url,
      description: msg || "(no text)",
      imageUrl,
      timestamp: p.created_time ? new Date(p.created_time).toISOString() : null,
    });

    console.log(`Sent: ${p.id}`);

    // Update state after each successful send
    state.last_post_id = p.id;
    saveState(state);
  }

  console.log("State updated.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
