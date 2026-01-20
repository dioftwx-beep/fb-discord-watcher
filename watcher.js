// watcher.js
// FB Page -> Discord Watcher
// - Fetches latest Page posts via Graph API
// - Sends NEW posts to Discord with an embed + image (uploaded as attachment for reliability)
// - Stores last_post_id in state.json

const fs = require("fs");

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
    throw new Error(`FB HTTP ${res.status}: Non-JSON response: ${text.slice(0, 300)}`);
  }

  if (!res.ok || json.error) {
    throw new Error(`FB HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function pickImageFromPost(post) {
  // 1) full_picture (works for many posts)
  if (post.full_picture) return post.full_picture;

  // 2) attachments.media.image.src
  const att0 = post.attachments?.data?.[0];
  const direct = att0?.media?.image?.src;
  if (direct) return direct;

  // 3) subattachments (album / multi-photo)
  const sub = att0?.subattachments?.data?.[0]?.media?.image?.src;
  if (sub) return sub;

  return null;
}

function cleanText(s) {
  return (s ? String(s) : "").trim();
}

function makeTitleFromMessage(msg) {
  if (!msg) return "New Facebook Page post";
  const oneLine = msg.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? oneLine.slice(0, 77) + "..." : oneLine;
}

async function sendToDiscord({ title, url, description, imageUrl, timestamp }) {
  // Base embed
  const embed = {
    title: title || "New post",
    url,
    description: (description || "").slice(0, 3500),
    timestamp: timestamp || new Date().toISOString(),
  };

  // If we have an image -> upload it as attachment (most reliable)
  if (imageUrl) {
    try {
      const imgRes = await fetch(imageUrl);
      if (imgRes.ok) {
        const arr = await imgRes.arrayBuffer();
        const buf = Buffer.from(arr);

        // Discord: reference attachment in embed via attachment://filename
        embed.image = { url: "attachment://image.jpg" };

        const payload = {
          username: "Spidey Bot",
          content: `New Facebook Page post\n${url}`,
          embeds: [embed],
        };

        const form = new FormData();
        form.append("payload_json", JSON.stringify(payload));
        form.append("files[0]", new Blob([buf]), "image.jpg");

        const res = await fetch(DISCORD_WEBHOOK_URL, {
          method: "POST",
          body: form,
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Discord HTTP ${res.status}: ${body}`);
        }
        return;
      }
      // If download fails, fall back to embed without attachment below
    } catch (e) {
      console.log("WARN: image download/upload failed, fallback to normal embed:", e?.message || e);
    }
  }

  // Fallback: normal embed (no uploaded image)
  const payload = {
    username: "Spidey Bot",
    content: `New Facebook Page post\n${url}`,
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

  // Important: request fields including image + attachments
  const fields = [
    "id",
    "message",
    "created_time",
    "permalink_url",
    "full_picture",
    "attachments{media{image},type,url,subattachments{media{image}}}",
  ].join(",");

  // /posts is OK for Page posts
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

  // First run: just initialize (no spam)
  if (!state.last_post_id) {
    state.last_post_id = posts[0].id;
    saveState(state);
    console.log("Initialized state. No notification sent.");
    return;
  }

  // Collect new posts until we hit last_post_id
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

    await sendToDiscord({
      title: makeTitleFromMessage(msg),
      url,
      description: msg || " ",
      imageUrl,
      timestamp: p.created_time || new Date().toISOString(),
    });

    console.log(`Sent: ${p.id}`);
  }

  // Update state to newest fetched post
  state.last_post_id = posts[0].id;
  saveState(state);
  console.log("State updated.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
