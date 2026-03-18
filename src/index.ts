/**
 * Barking Lot Facebook Integration Worker
 * - Proxies Facebook Graph API posts (cached in KV)
 * - Messenger webhook for auto-responses
 * - CORS-enabled for barkinglot.org
 */

interface Env {
  CACHE: KVNamespace;
  FB_PAGE_ID: string;
  FB_APP_ID: string;
  FB_PAGE_TOKEN: string;
  FB_APP_SECRET: string;
  FB_VERIFY_TOKEN: string;
  ALLOWED_ORIGINS: string;
}

interface FacebookPost {
  id: string;
  message?: string;
  created_time: string;
  full_picture?: string;
  permalink_url?: string;
  attachments?: {
    data: Array<{
      media?: { image?: { src: string; width: number; height: number } };
      type?: string;
      title?: string;
      description?: string;
      subattachments?: {
        data: Array<{
          media?: { image?: { src: string } };
          type?: string;
        }>;
      };
    }>;
  };
}

interface MessengerEntry {
  messaging: Array<{
    sender: { id: string };
    recipient: { id: string };
    timestamp: number;
    message?: {
      mid: string;
      text?: string;
      attachments?: Array<{ type: string; payload: { url: string } }>;
    };
    postback?: { title: string; payload: string };
  }>;
}

// ─── CORS ───────────────────────────────────────────────────────
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  const isAllowed = allowed.includes(origin) || origin.includes("localhost");
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : allowed[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data: unknown, status: number, request: Request, env: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request, env) },
  });
}

// ─── Facebook Graph API ─────────────────────────────────────────
async function fetchFacebookPosts(env: Env, limit = 25, includeAttachments = false): Promise<FacebookPost[]> {
  const fields = includeAttachments
    ? "message,created_time,full_picture,permalink_url,attachments{media,title,description,type,subattachments}"
    : "message,created_time,full_picture,permalink_url";
  const url = `https://graph.facebook.com/v21.0/${env.FB_PAGE_ID}/posts?fields=${fields}&limit=${limit}&access_token=${env.FB_PAGE_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Facebook API error: ${res.status} ${err}`);
  }
  const data = (await res.json()) as { data: FacebookPost[] };
  return data.data;
}

async function fetchPageInfo(env: Env) {
  const fields = "name,about,category,fan_count,link,picture,cover,phone,location,website,hours,emails";
  const url = `https://graph.facebook.com/v21.0/${env.FB_PAGE_ID}?fields=${fields}&access_token=${env.FB_PAGE_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Facebook API error: ${res.status}`);
  return res.json();
}

// ─── Cached endpoints ───────────────────────────────────────────
async function getPosts(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "25"), 100);
  const forceRefresh = url.searchParams.get("refresh") === "true";
  const cacheKey = `fb_posts_${limit}`;

  if (!forceRefresh) {
    const cached = await env.CACHE.get(cacheKey, "json");
    if (cached) return json({ posts: cached, cached: true, count: (cached as FacebookPost[]).length }, 200, request, env);
  }

  const posts = await fetchFacebookPosts(env, limit);

  // Filter to only posts with content (message or picture)
  const filtered = posts.filter((p) => p.message || p.full_picture);

  // Cache for 15 minutes
  await env.CACHE.put(cacheKey, JSON.stringify(filtered), { expirationTtl: 900 });

  return json({ posts: filtered, cached: false, count: filtered.length }, 200, request, env);
}

async function getPageInfo(request: Request, env: Env): Promise<Response> {
  const cacheKey = "fb_page_info";
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return json({ page: cached, cached: true }, 200, request, env);

  const info = await fetchPageInfo(env);
  await env.CACHE.put(cacheKey, JSON.stringify(info), { expirationTtl: 3600 });

  return json({ page: info, cached: false }, 200, request, env);
}

// ─── Animal detection from posts ────────────────────────────────
function extractAnimalPosts(posts: FacebookPost[]): Array<{
  id: string;
  name: string | null;
  description: string;
  image: string | null;
  date: string;
  permalink: string;
  type: "dog" | "cat" | "other";
  isAdoptable: boolean;
}> {
  const adoptionKeywords = ["adopt", "foster", "application", "forever home", "looking for", "available", "meet ", "needs a home"];
  const dogKeywords = ["dog", "puppy", "pup", "canine", "collie", "pit", "lab", "shepherd", "terrier", "hound", "retriever", "mix"];
  const catKeywords = ["cat", "kitten", "kitty", "feline"];

  return posts
    .filter((p) => p.message && (p.full_picture || p.attachments))
    .map((post) => {
      const msg = (post.message || "").toLowerCase();
      const isAdoptable = adoptionKeywords.some((kw) => msg.includes(kw));

      // Try to extract animal name from "Meet [Name]" pattern
      const nameMatch = (post.message || "").match(/(?:Meet|Introducing|This is|Say hello to)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/);
      const name = nameMatch ? nameMatch[1] : null;

      const isDog = dogKeywords.some((kw) => msg.includes(kw));
      const isCat = catKeywords.some((kw) => msg.includes(kw));
      const type: "dog" | "cat" | "other" = isDog ? "dog" : isCat ? "cat" : "other";

      let image = post.full_picture || null;
      if (!image && post.attachments?.data?.[0]?.media?.image?.src) {
        image = post.attachments.data[0].media.image.src;
      }

      return {
        id: post.id,
        name,
        description: (post.message || "").substring(0, 500),
        image,
        date: post.created_time,
        permalink: post.permalink_url || `https://facebook.com/${post.id}`,
        type,
        isAdoptable,
      };
    });
}

async function getAnimals(request: Request, env: Env): Promise<Response> {
  const cacheKey = "fb_animals";
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return json({ animals: cached, cached: true, count: (cached as unknown[]).length }, 200, request, env);

  try {
    const posts = await fetchFacebookPosts(env, 25);
    const animals = extractAnimalPosts(posts);
    await env.CACHE.put(cacheKey, JSON.stringify(animals), { expirationTtl: 900 });
    return json({ animals, cached: false, count: animals.length }, 200, request, env);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`getAnimals error: ${message}`);
    return json({ error: message, animals: [] }, 500, request, env);
  }
}

// ─── Messenger Bot ──────────────────────────────────────────────
const SANCTUARY_INFO = {
  name: "The Barking Lot",
  address: "401 Young St, Big Spring, TX 79720",
  phone: "(432) 232-9884",
  email: "info@barkinglot.org",
  adoptEmail: "adopt@barkinglot.org",
  hours: "Tuesday-Sunday 10 AM - 6 PM, Monday Closed",
  website: "https://barkinglot.org",
  venmo: "https://www.venmo.com/u/TheTexasBarkingLot",
  cashapp: "https://cash.app/$TEXASBARKINGLOT",
  applicationUrl: "https://www.jotform.com/assign/242957434131153/242978620418060",
  ein: "39-2743613",
  about: "Non-Profit 501(c)(3) Animal Sanctuary in Big Spring, Texas. We rescue, rehabilitate, and rehome animals in need.",
};

function generateBotResponse(text: string): { text?: string; quickReplies?: string[] } {
  const lower = text.toLowerCase().trim();

  // Greetings
  if (/^(hi|hello|hey|howdy|good\s*(morning|afternoon|evening))/.test(lower)) {
    return {
      text: `Hey there! 🐾 Welcome to The Barking Lot Animal Sanctuary! We're a 501(c)(3) nonprofit in Big Spring, TX dedicated to rescuing and rehoming animals in need.\n\nHow can I help you today?`,
      quickReplies: ["Available Animals", "How to Adopt", "Donate", "Volunteer", "Hours & Location"],
    };
  }

  // Adoption
  if (/adopt|adoption|available|animals|pets|dogs|cats|puppies|kittens/.test(lower)) {
    return {
      text: `🐾 We'd love to help you find your perfect match!\n\nTo see our available animals, visit our website:\n${SANCTUARY_INFO.website}\n\nOr check our Facebook page for the latest arrivals and adoption posts.\n\nTo apply to adopt, fill out our application:\n${SANCTUARY_INFO.applicationUrl}\n\nYou can also email us at ${SANCTUARY_INFO.adoptEmail} or call ${SANCTUARY_INFO.phone} to ask about specific animals!`,
      quickReplies: ["Application Link", "Hours & Location", "Fostering"],
    };
  }

  // Foster
  if (/foster/.test(lower)) {
    return {
      text: `💛 Fostering saves lives! When you foster, you give an animal a safe, loving temporary home while they wait for their forever family.\n\nWe provide all supplies (food, crate, medical care). You provide the love!\n\nTo apply to foster, fill out our application:\n${SANCTUARY_INFO.applicationUrl}\n\nOr email us at ${SANCTUARY_INFO.adoptEmail}`,
      quickReplies: ["How to Adopt", "Donate", "Volunteer"],
    };
  }

  // Donate
  if (/donat|give|help|support|contribute|money|fund/.test(lower)) {
    return {
      text: `💛 Thank you for wanting to help! Every dollar goes directly to saving animal lives.\n\n💸 Venmo: ${SANCTUARY_INFO.venmo}\n💸 CashApp: ${SANCTUARY_INFO.cashapp}\n\nWe also accept:\n• Dog/cat food donations\n• Blankets, towels, and bedding\n• Cleaning supplies\n• Building materials\n\nDrop-off at: ${SANCTUARY_INFO.address}\n\nWe're a 501(c)(3) — EIN: ${SANCTUARY_INFO.ein} — all donations are tax-deductible! 🧾`,
      quickReplies: ["What You Need Most", "Hours & Location", "Volunteer"],
    };
  }

  // Volunteer
  if (/volunteer|help out|pitch in/.test(lower)) {
    return {
      text: `🙌 We love our volunteers! There are many ways to help:\n\n• Dog walking & socialization\n• Cleaning kennels\n• Event support\n• Transport runs\n• Building & maintenance\n• Photography\n• Social media\n\nEmail us at ${SANCTUARY_INFO.email} or call ${SANCTUARY_INFO.phone} to get started!\n\nOr just stop by during our hours — we can always use extra hands!`,
      quickReplies: ["Hours & Location", "Donate", "Events"],
    };
  }

  // Hours & Location
  if (/hour|open|close|location|address|where|directions|visit/.test(lower)) {
    return {
      text: `📍 The Barking Lot\n${SANCTUARY_INFO.address}\n\n🕐 Hours:\n${SANCTUARY_INFO.hours}\n\n📞 ${SANCTUARY_INFO.phone}\n📧 ${SANCTUARY_INFO.email}\n🌐 ${SANCTUARY_INFO.website}\n\nCome visit — the animals would love to meet you! 🐾`,
      quickReplies: ["Available Animals", "Donate", "Volunteer"],
    };
  }

  // Supplies needed
  if (/need|supplies|wishlist|what.*need|most needed/.test(lower)) {
    return {
      text: `Right now we could really use:\n\n🐶 Puppy & dog food\n🐱 Kitten formula & cat food\n🏕 Mesh tarps for shade\n🏠 Dog houses\n🧹 Cleaning supplies\n🛏 Blankets and towels\n💊 Flea/tick prevention\n\nDrop off at: ${SANCTUARY_INFO.address}\nOr order from our wishlist and ship directly to us!\n\n💸 Cash donations: ${SANCTUARY_INFO.venmo}`,
      quickReplies: ["Donate", "Hours & Location", "Volunteer"],
    };
  }

  // Report animal / emergency
  if (/report|stray|found|lost|emergency|cruelty|abuse|neglect|injured/.test(lower)) {
    return {
      text: `🚨 Thank you for reaching out about an animal in need.\n\nFor emergencies or to report animal cruelty:\n📞 Call us: ${SANCTUARY_INFO.phone}\n📞 Big Spring Animal Control: (432) 264-2372\n\nIf you've found a stray or lost pet:\n• Take a photo and note the location\n• Check for a collar/tag\n• Contact us with the details\n\nWe'll do everything we can to help. 🐾`,
      quickReplies: ["Hours & Location", "How to Adopt"],
    };
  }

  // Events
  if (/event|fundrais|adoption.*event|meet.*greet/.test(lower)) {
    return {
      text: `🎉 We host adoption events, fundraisers, and community gatherings throughout the year!\n\nFollow our Facebook page for the latest events:\nhttps://www.facebook.com/105558179275338\n\nOr check our website: ${SANCTUARY_INFO.website}\n\nWant to help organize an event? Email ${SANCTUARY_INFO.email}!`,
      quickReplies: ["Available Animals", "Donate", "Volunteer"],
    };
  }

  // Application
  if (/application|apply|form/.test(lower)) {
    return {
      text: `📋 Here's our adoption/foster application:\n${SANCTUARY_INFO.applicationUrl}\n\nFill it out and we'll review it promptly! You can also email ${SANCTUARY_INFO.adoptEmail} with any questions.`,
      quickReplies: ["Available Animals", "Hours & Location"],
    };
  }

  // Thank you
  if (/thank|thanks|appreciate/.test(lower)) {
    return {
      text: `You're so welcome! 🐾💛 Thank you for caring about our animals. If you need anything else, just message us anytime!\n\nRemember — sharing our posts helps save lives too! 🙌`,
    };
  }

  // Default
  return {
    text: `Thanks for your message! 🐾\n\nI can help with:\n• 🐶 Available animals for adoption\n• 📋 Adoption/foster applications\n• 💛 How to donate\n• 🙌 Volunteering\n• 📍 Hours & location\n• 🚨 Reporting strays or emergencies\n\nJust ask, or tap one of the options below!`,
    quickReplies: ["Available Animals", "How to Adopt", "Donate", "Hours & Location", "Volunteer", "Report Animal"],
  };
}

async function sendMessengerResponse(recipientId: string, responseData: { text?: string; quickReplies?: string[] }, env: Env) {
  const messagePayload: Record<string, unknown> = {};

  if (responseData.text) {
    messagePayload.text = responseData.text;
  }

  if (responseData.quickReplies && responseData.quickReplies.length > 0) {
    messagePayload.quick_replies = responseData.quickReplies.map((title) => ({
      content_type: "text",
      title: title.substring(0, 20),
      payload: title.toUpperCase().replace(/\s+/g, "_"),
    }));
  }

  const body = {
    recipient: { id: recipientId },
    message: messagePayload,
    messaging_type: "RESPONSE",
  };

  const res = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${env.FB_PAGE_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`Messenger send error: ${res.status} ${err}`);
  }
}

async function handleMessengerWebhook(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { object: string; entry: MessengerEntry[] };

  if (body.object !== "page") {
    return new Response("Not a page event", { status: 404 });
  }

  for (const entry of body.entry) {
    for (const event of entry.messaging) {
      const senderId = event.sender.id;

      // Don't respond to our own messages
      if (senderId === env.FB_PAGE_ID) continue;

      let userText = "";

      if (event.message?.text) {
        userText = event.message.text;
      } else if (event.postback?.payload) {
        userText = event.postback.payload.replace(/_/g, " ").toLowerCase();
      } else if (event.message?.attachments) {
        userText = "image";
      }

      if (userText) {
        const response = generateBotResponse(userText);
        await sendMessengerResponse(senderId, response, env);
      }
    }
  }

  return new Response("EVENT_RECEIVED", { status: 200 });
}

function verifyMessengerWebhook(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === env.FB_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

// ─── Widget embed script ────────────────────────────────────────
function getWidgetScript(env: Env): string {
  return `
(function() {
  var container = document.getElementById('barking-lot-feed');
  if (!container) return;

  var style = document.createElement('style');
  style.textContent = \`
    .bl-feed { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; }
    .bl-feed h2 { text-align: center; color: #1a1a1a; margin-bottom: 1.5rem; }
    .bl-post { background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 1.5rem; overflow: hidden; transition: transform 0.2s; }
    .bl-post:hover { transform: translateY(-2px); box-shadow: 0 4px 16px rgba(0,0,0,0.15); }
    .bl-post img { width: 100%; height: 300px; object-fit: cover; }
    .bl-post-body { padding: 1.25rem; }
    .bl-post-date { color: #666; font-size: 0.85rem; margin-bottom: 0.5rem; }
    .bl-post-text { color: #333; line-height: 1.6; white-space: pre-wrap; }
    .bl-post-text.truncated { max-height: 150px; overflow: hidden; position: relative; }
    .bl-post-text.truncated::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 40px; background: linear-gradient(transparent, white); }
    .bl-post-link { display: inline-block; margin-top: 0.75rem; color: #4267B2; text-decoration: none; font-weight: 500; }
    .bl-post-link:hover { text-decoration: underline; }
    .bl-loading { text-align: center; padding: 2rem; color: #666; }
  \`;
  document.head.appendChild(style);

  container.innerHTML = '<div class="bl-loading">Loading posts from Facebook...</div>';

  fetch('https://barking-lot-facebook.bmcii1976.workers.dev/api/posts?limit=10')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var html = '<div class="bl-feed"><h2>Latest from Facebook</h2>';
      (data.posts || []).forEach(function(post) {
        var date = new Date(post.created_time).toLocaleDateString('en-US', {month: 'long', day: 'numeric', year: 'numeric'});
        var text = (post.message || '').substring(0, 400);
        var truncated = (post.message || '').length > 400 ? ' truncated' : '';
        html += '<div class="bl-post">';
        if (post.full_picture) html += '<img src="' + post.full_picture + '" alt="Post image" loading="lazy">';
        html += '<div class="bl-post-body">';
        html += '<div class="bl-post-date">' + date + '</div>';
        if (text) html += '<div class="bl-post-text' + truncated + '">' + text.replace(/</g,'&lt;') + '</div>';
        html += '<a class="bl-post-link" href="' + post.permalink_url + '" target="_blank" rel="noopener">View on Facebook →</a>';
        html += '</div></div>';
      });
      html += '</div>';
      container.innerHTML = html;
    })
    .catch(function(err) {
      container.innerHTML = '<div class="bl-loading">Unable to load posts. <a href="https://facebook.com/105558179275338" target="_blank">Visit our Facebook page</a></div>';
    });
})();`;
}

// ─── Router ─────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      // Facebook posts feed
      if (path === "/api/posts" && request.method === "GET") {
        return getPosts(request, env);
      }

      // Page info
      if (path === "/api/page" && request.method === "GET") {
        return getPageInfo(request, env);
      }

      // Extracted animal listings
      if (path === "/api/animals" && request.method === "GET") {
        return getAnimals(request, env);
      }

      // Embeddable widget script
      if (path === "/widget.js") {
        return new Response(getWidgetScript(env), {
          headers: { "Content-Type": "application/javascript", "Cache-Control": "public, max-age=300", ...corsHeaders(request, env) },
        });
      }

      // Messenger webhook verification (GET)
      if (path === "/webhook" && request.method === "GET") {
        return verifyMessengerWebhook(request, env);
      }

      // Messenger webhook events (POST)
      if (path === "/webhook" && request.method === "POST") {
        return handleMessengerWebhook(request, env);
      }

      // Health check
      if (path === "/health") {
        return json(
          {
            status: "ok",
            service: "barking-lot-facebook",
            version: "1.0.0",
            timestamp: new Date().toISOString(),
            endpoints: ["/api/posts", "/api/page", "/api/animals", "/widget.js", "/webhook"],
          },
          200,
          request,
          env
        );
      }

      // Root
      if (path === "/") {
        return json(
          {
            service: "Barking Lot Facebook Integration",
            version: "1.0.0",
            description: "Facebook feed proxy and Messenger bot for The Barking Lot Animal Sanctuary",
            endpoints: {
              "GET /api/posts": "Recent Facebook posts (cached 15min)",
              "GET /api/page": "Page info (cached 1hr)",
              "GET /api/animals": "Extracted animal listings from posts",
              "GET /widget.js": "Embeddable feed widget script",
              "GET /webhook": "Messenger webhook verification",
              "POST /webhook": "Messenger webhook events",
              "GET /health": "Health check",
            },
          },
          200,
          request,
          env
        );
      }

      return json({ error: "Not found" }, 404, request, env);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
      console.error(`Error: ${message}`);
      return json({ error: message }, 500, request, env);
    }
  },
};
