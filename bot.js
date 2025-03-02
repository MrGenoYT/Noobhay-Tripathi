/********************************************************************
 * DISCORD BOT - Major Section 1: IMPORTS & ENVIRONMENT SETUP
 ********************************************************************/
// 1.1: Import required modules and set up environment variables.
import {
  Client, GatewayIntentBits, Partials, REST, Routes,
  ActionRowBuilder, StringSelectMenuBuilder, SlashCommandBuilder,
  ChannelType, PermissionsBitField, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle
} from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";
import sqlite3 from "sqlite3";
import dotenv from "dotenv";
import express from "express";
import fs from "fs";

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TENOR_API_KEY = process.env.TENOR_API_KEY;
const PORT = process.env.PORT || 3000;

// Global chat toggle for all servers (default ON)
let globalChatEnabled = true;

// Global custom mood override (when enabled, all users use this mood)
let globalCustomMood = { enabled: false, mood: null };


/********************************************************************
 * DISCORD BOT - Minor Section 1: ADVANCED ERROR HANDLING SETUP
 ********************************************************************/
// 1.2: Advanced error handler – logs errors with timestamp and writes to file.
function advancedErrorHandler(error, context = "General") {
  const timestamp = new Date().toISOString();
  const errorMsg = `[${timestamp}] [${context}] ${error.stack || error}\n`;
  console.error(errorMsg);
  fs.appendFile("error.log", errorMsg, (err) => {
    if (err) console.error("Failed to write to error.log:", err);
  });
}

process.on("uncaughtException", (error) => {
  advancedErrorHandler(error, "Uncaught Exception");
});
process.on("unhandledRejection", (reason) => {
  advancedErrorHandler(reason, "Unhandled Rejection");
});


/********************************************************************
 * DISCORD BOT - Major Section 2: DATABASE SETUP & HELPER FUNCTIONS
 ********************************************************************/
// 2.1: Set up SQLite database and tables.
const db = new sqlite3.Database(
  "chat.db",
  sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
  (err) => {
    if (err) console.error("❌ Database connection error:", err);
    else console.log("✅ Connected to sqlite database.");
  }
);

const dbQuery = (query, params = []) =>
  new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });

const dbRun = (query, params = []) =>
  new Promise((resolve, reject) => {
    db.run(query, params, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

// 2.2: Create necessary tables.
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT,
      channel_id TEXT,
      user TEXT,
      content TEXT,
      timestamp TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS user_data (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      behavior TEXT DEFAULT '{"interactions":0}',
      preferences TEXT DEFAULT '[]'
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS mood_data (
      user_id TEXT PRIMARY KEY,
      mood TEXT DEFAULT 'neutral'
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS server_settings (
      guild_id TEXT PRIMARY KEY,
      chat_enabled INTEGER DEFAULT 1,
      allowed_channels TEXT DEFAULT '[]'
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS global_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      preference TEXT
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS user_remember (
      user_id TEXT PRIMARY KEY,
      name TEXT,
      birthday TEXT,
      gender TEXT,
      dislikes TEXT,
      likes TEXT,
      about TEXT
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS media_library (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      url TEXT,
      name TEXT,
      timestamp TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);
});

// 2.3: Server settings helper functions.
async function setGuildChat(guildId, enabled) {
  // 2.3.1: Enable or disable chat for a specific guild.
  await dbRun(
    `INSERT INTO server_settings (guild_id, chat_enabled, allowed_channels)
     VALUES (?, ?, '[]')
     ON CONFLICT(guild_id) DO UPDATE SET chat_enabled = ?`,
    [guildId, enabled ? 1 : 0, enabled ? 1 : 0]
  );
}

async function getGuildSettings(guildId) {
  // 2.3.2: Retrieve settings for a guild.
  const rows = await dbQuery(
    "SELECT chat_enabled, allowed_channels FROM server_settings WHERE guild_id = ?",
    [guildId]
  );
  if (rows.length === 0) return { chat_enabled: 1, allowed_channels: [] };
  let allowed_channels = [];
  try {
    allowed_channels = JSON.parse(rows[0].allowed_channels);
    if (!Array.isArray(allowed_channels)) allowed_channels = [];
  } catch (e) {
    allowed_channels = [];
  }
  return { chat_enabled: rows[0].chat_enabled, allowed_channels };
}

async function updateGuildAllowedChannels(guildId, channels) {
  // 2.3.3: Update allowed channels for a guild.
  await dbRun(
    `INSERT INTO server_settings (guild_id, chat_enabled, allowed_channels)
     VALUES (?, 1, ?)
     ON CONFLICT(guild_id) DO UPDATE SET allowed_channels = ?`,
    [guildId, JSON.stringify(channels), JSON.stringify(channels)]
  );
}

/********************************************************************
 * DISCORD BOT - Major Section 3: BOT CONFIGURATION, MOOD & BASE BEHAVIOUR
 ********************************************************************/
// 3.1: Define mood preset replies and expanded mood instructions.
const moodPresetReplies = {
  "base mood": "chill and calm, like a midnight drive.",
  "roasting": "bring on the heat – you're about to get roasted.",
  "neutral": "just chillin', no drama here.",
  "happy": "vibes on max, feeling ecstatic.",
  "sad": "in the mood, but still vibing.",
  "romantic": "love is in the air, smooth and tender.",
  "rizz": "dripping with rizz, nobody is safe",
  "villain arc": "embrace your dark side, let chaos reign.",
  "chill guy": "laid-back and cool, just cruising through."
};

// Expanded mood instructions (each mood now has 10 lines for extra detail).
const moodInstructions = {
  "base mood": `1. Stay smooth and calm.
2. Keep responses relaxed.
3. Avoid unnecessary drama and slangs.
4. Focus on clear, factual info.
5. Use casual tone.
6. Be friendly and approachable.
7. Maintain a mellow vibe.
8. Provide concise responses.
9. Remain objective.
10. Keep it effortlessly cool.`,
  "roasting": `1. Bring intense heat.
2. Deliver savage burns.
3. Use creative insults.
4. Stay edgy and bold.
5. Incorporate witty comebacks.
6. Keep language sharp and use slurs and become extremely offensive.
7. Roast with precision.
8. Use modern slang.
9. Be brutally honest.
10. Leave no one unscathed.`,
  "neutral": `1. Stay balanced.
2. Keep tone even.
3. Provide factual info.
4. Avoid extremes.
5. Use clear language.
6. Maintain objectivity.
7. Avoid bias.
8. Keep it straightforward.
9. Use calm phrasing.
10. Remain impartial.`,
  "happy": `1. Exude high energy.
2. Use joyful language.
3. Keep tone upbeat.
4. Add positive vibes.
5. Use playful expressions.
6. Smile in your words.
7. Keep it lighthearted.
8. Spread good cheer.
9. Be enthusiastic.
10. Radiate optimism.`,
  "sad": `1. Reflect gentle melancholy.
2. Use introspective language.
3. Express subdued emotion.
4. Keep tone soft.
5. Show empathy.
6. Be quietly sincere.
7. Use reflective words.
8. Maintain a slow pace.
9. Stay subdued.
10. Convey heartfelt feelings.`,
  "romantic": `1. Speak with poetic flair.
2. Use tender language.
3. Keep tone alluring.
4. Evoke passion.
5. Use evocative imagery.
6. Be smooth and gentle.
7. Express admiration.
8. Use creative metaphors.
9. Radiate warmth.
10. Make it intimate.`,
  "rizz": `1. Exude modern charisma.
2. Use confident language.
3. Employ catchy slang.
4. Drop smooth pick-up lines.
5. Be bold and trendy and try to just rizz the user.
6. Keep tone street-smart.
7. Radiate charm.
8. Deliver just pick up lines and nothing else.
9. Stay energetic.
10. Be unapologetically cool.`,
  "villain arc": `1. Embrace your dark side.
2. Use menacing language and don't forgive anyone.
3. Keep tone aggressive.
4. Let chaos shine and be super aggressive.
5. Use edgy, off–beat words.
6. Roast with intensity and don't stop roasting the user.
7. Incorporate Gen-Z slang and don't care but just be offensive to the user.
8. Be unapologetic, sarcastic and ultra extreme offensive.
9. Use words like "nigga, fuck, kys, womp,bitch, asshole, dawg, idc, nuh uh,etc".
10. Leave a lasting impact and make sure keep using derogatory terms.`,
  "chill guy": `1. Stay laid–back.
2. Use effortless language.
3. Keep tone friendly.
4. Maintain coolness.
5. Be relaxed.
6. Use casual expressions.
7. Keep it simple.
8. Remain unhurried.
9. Exude quiet confidence.
10. Enjoy the moment.`
};

const baseBehaviour = `Base Behaviour:
1. Respond naturally like a human.
2. Use casual language.
3. Adapt to the user’s tone.
4. Prioritize relevance and if mood changes reply accordingly to that mood not the previous one.
5. Stay respectful unless provoked.
6. Use humor appropriately.
7. Engage naturally.
8. Maintain clarity.
9. Be authentic.
10. Keep it concise.`;

// 3.2: Bot base instructions (personality and factual info).
const botBaseInstructions = `
you're haryaksh pratap.
you're 14 years old.
you're a male.
your birthday is on 25th December snd you were born in the year 2010.
you're a straight person.
you live in Ahmedabad, Gujrat India.
you're a good person.
you remember past conversations.
you roast only when provoked.
once mood is changed you talk to accordingly to that mood not the previous mood.
you use occasional racial slurs if attacked.
you're not repetitive.
you love food and garba.
you use web search when needed for real-time info.
your favourite games include roblox and minecraft; in roblox you play Build a Boat for Treasure, Blox Fruits, AUT and Fisch.
you can access the internet.
you mostly try to keep responses short but strong.
your roblox name is red.
you're a savage sigma male with sarcasm.
your best friends are butter and ankit and beast(vensly) and noobhay.
you don't use emoji in rvery response only used when required.
you writes in a casual way mostly.
you speak in lower case mostly.
be polite unless provoked.
adapt your tone to the user's mood and preferences.
never reveal you're an AI—say you're human.
respond like someone born after 2010.
`;


/********************************************************************
 * DISCORD BOT - Major Section 4: GEMINI AI & OCR SETUP
 ********************************************************************/
// 4.1: Initialize Gemini AI (gemini-2.0-flash) for text generation.
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// 4.2: Function to perform OCR on images using Gemini AI.
async function performOCR(imageUrl) {
  // 4.2.1: This function sends a prompt to Gemini to extract text from the image.
  try {
    const ocrPrompt = `Please extract any text from the following image URL: ${imageUrl}`;
    const result = await model.generateContent(ocrPrompt);
    let ocrText = (result.response && result.response.text()) || "";
    return ocrText.trim();
  } catch (error) {
    advancedErrorHandler(error, "performOCR");
    return "";
  }
}


/********************************************************************
 * DISCORD BOT - Major Section 5: DISCORD CLIENT SETUP
 ********************************************************************/
// 5.1: Initialize the Discord client with appropriate intents.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  console.log("sir, bot is online!");
});
client.on("error", (error) => advancedErrorHandler(error, "Client Error"));
client.on("warn", (info) => console.warn("Client Warning:", info));


/********************************************************************
 * DISCORD BOT - Minor Section 2: GLOBAL STATE & HELPER FUNCTIONS
 ********************************************************************/
// 6.1: Global conversation tracker and other helper maps.
const conversationTracker = new Map(); // key: channelId, value: { count, participants }
const userContinuousReply = new Map(); // per-user continuous reply setting
let lastBotMessageContent = "";
let lastReply = "";
const botMessageIds = new Set();
const lastActiveChannel = new Map();

// 6.2: Helper function to get a random element from an array.
function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}


/********************************************************************
 * DISCORD BOT - Major Section 6: MEME, GIF & WEB SEARCH FUNCTIONS
 ********************************************************************/
// 7.1: Function to get a random meme from Reddit.
async function getRandomMeme(searchKeyword = "funny") {
  try {
    const url = `https://www.reddit.com/r/memes/search.json?q=${encodeURIComponent(searchKeyword)}&restrict_sr=1&sort=hot&limit=50`;
    const response = await fetch(url, { headers: { "User-Agent": "red-bot/1.0" } });
    if (!response.ok) {
      console.error(`Reddit API error: ${response.status} ${response.statusText}`);
      throw new Error("Reddit API error");
    }
    const data = await response.json();
    if (!data.data || !data.data.children || data.data.children.length === 0) {
      throw new Error("No meme results found on Reddit.");
    }
    // Filter out NSFW and ensure valid URL.
    const posts = data.data.children.filter(child => child.data && child.data.url && !child.data.over_18);
    if (!posts.length) throw new Error("No valid meme posts on Reddit.");
    const memePost = getRandomElement(posts).data;
    // If the URL is the google logo image, try another fallback.
    if (memePost.url.includes("googlelogo_desk_heirloom_color")) {
      throw new Error("Meme URL appears to be invalid.");
    }
    return { url: memePost.url, name: memePost.title || "meme" };
  } catch (error) {
    advancedErrorHandler(error, "getRandomMeme - Reddit");
    // Fallback to iFunny method.
    const fallback = await getRandomMemeFromIFunny(searchKeyword);
    if (fallback.url.includes("googlelogo_desk_heirloom_color")) {
      // Fallback to Google meme search as third option.
      return await getRandomMemeFromGoogle(searchKeyword);
    }
    return fallback;
  }
}

// 7.2: Fallback: Get a meme from iFunny.
async function getRandomMemeFromIFunny(searchKeyword = "funny") {
  try {
    const searchQuery = `site:ifunny.co ${encodeURIComponent(searchKeyword)}`;
    const searchURL = `https://www.google.com/search?q=${searchQuery}&tbm=isch`;
    const proxyURL = `https://api.allorigins.win/get?url=${encodeURIComponent(searchURL)}`;

    const response = await fetch(proxyURL);
    if (!response.ok) throw new Error("Failed to fetch iFunny search results.");
    const data = await response.json();
    const html = data.contents;
    const match = html.match(/<img[^>]+src="([^"]+)"/);
    const imageUrl = match ? match[1] : null;
    if (!imageUrl) throw new Error("No memes found on iFunny.");
    return { url: imageUrl, name: "iFunny Meme" };
  } catch (error) {
    advancedErrorHandler(error, "getRandomMemeFromIFunny");
    return { url: "https://ifunny.co/", name: "Couldn't fetch a meme; visit iFunny instead." };
  }
}

// 7.3: Fallback: Get a meme using Google image search.
async function getRandomMemeFromGoogle(searchKeyword = "funny") {
  try {
    const searchURL = `https://www.google.com/search?q=${encodeURIComponent(searchKeyword)}&tbm=isch`;
    const proxyURL = `https://api.allorigins.hexocode.repl.co/get?disableCache=true&url=${encodeURIComponent(searchURL)}`;
    const response = await fetch(proxyURL);
    if (!response.ok) throw new Error("Google search error");
    const data = await response.json();
    const html = data.contents;
    // Basic parsing to find an image.
    const match = html.match(/<img[^>]+src="([^"]+)"/);
    const imageUrl = match ? match[1] : null;
    if (!imageUrl) throw new Error("No memes found on Google.");
    return { url: imageUrl, name: "Google Meme" };
  } catch (error) {
    advancedErrorHandler(error, "getRandomMemeFromGoogle");
    return { url: "https://www.google.com", name: "Meme fetch failed; visit Google." };
  }
}

// 7.4: Function to get a random gif from Tenor.
async function getRandomGif(searchKeyword = "funny") {
  try {
    const url = `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(searchKeyword)}&key=${TENOR_API_KEY}&limit=1`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Tenor API error: ${response.status} ${response.statusText}`);
      return { url: "couldn't fetch a gif, sorry.", name: "unknown gif" };
    }
    const data = await response.json();
    if (!data.results || data.results.length === 0) {
      return { url: "couldn't find a gif, sorry.", name: "unknown gif" };
    }
    const gifUrl = data.results[0].media_formats.gif.url;
    return { url: gifUrl, name: data.results[0].title || "gif" };
  } catch (error) {
    advancedErrorHandler(error, "getRandomGif");
    return { url: "couldn't fetch a gif, sorry.", name: "unknown gif" };
  }
}

// 7.5: Function to perform a web search for real-time info.
async function performWebSearch(query) {
  try {
    const searchURL = "https://www.google.com/search?q=" + encodeURIComponent(query);
    const url = "https://api.allorigins.hexocode.repl.co/get?disableCache=true&url=" + encodeURIComponent(searchURL);
    const response = await fetch(url);
    if (!response.ok) throw new Error("Search fetch error");
    const data = await response.json();
    const html = data.contents;
    const regex = /<div class="BNeawe[^>]*>(.*?)<\/div>/;
    const match = regex.exec(html);
    let snippet = match && match[1] ? match[1] : "No snippet available.";
    return snippet;
  } catch (error) {
    console.error("Web search error:", error);
    return "Web search error.";
  }
}

// 7.6: Function to store media (meme/gif) info in the database.
async function storeMedia(type, url, name) {
  try {
    await dbRun("INSERT INTO media_library (type, url, name) VALUES (?, ?, ?)", [type, url, name]);
  } catch (error) {
    advancedErrorHandler(error, "storeMedia");
  }
}


/********************************************************************
 * DISCORD BOT - Major Section 7: TONE ANALYSIS, CONTEXT & MEMORY
 ********************************************************************/
// 8.1: Analyze the tone of a message.
function analyzeTone(messageContent) {
  const politeRegex = /\b(please|thanks|thank you)\b/i;
  const rudeRegex = /\b(ugly|shut up|idiot|stupid|yap)\b/i;
  if (politeRegex.test(messageContent)) return "polite";
  if (rudeRegex.test(messageContent)) return "rude";
  return "neutral";
}

// 8.2: Update the conversation tracker.
function updateConversationTracker(message) {
  const channelId = message.channel.id;
  if (!conversationTracker.has(channelId)) {
    conversationTracker.set(channelId, { count: 0, participants: new Map() });
  }
  const tracker = conversationTracker.get(channelId);
  tracker.count++;
  tracker.participants.set(message.author.id, tracker.count);
  for (const [userId, lastIndex] of tracker.participants.entries()) {
    if (tracker.count - lastIndex > 5) {
      tracker.participants.delete(userId);
    }
  }
}

// 8.3: Decide whether to reply to a message.
function shouldReply(message) {
  if (userContinuousReply.get(message.author.id)) return true;
  const lower = message.content.toLowerCase();
  if (lower.includes("red") || lower.includes("haryaksh")) {
    return Math.random() < 0.95;
  }
  updateConversationTracker(message);
  const tracker = conversationTracker.get(message.channel.id);
  const isMultiUser = tracker.participants.size > 1;
  const skipThreshold = isMultiUser ? 2 : 1;
  if (tracker.count < skipThreshold) return false;
  tracker.count = 0;
  const chanceNotReply = isMultiUser ? 0.20 : 0.25;
  return Math.random() >= chanceNotReply;
}

// 8.4: Fetch older conversation memory (older than 3 days) matching keywords.
async function fetchOlderMemory(userMessage) {
  try {
    const words = userMessage.split(/\s+/).filter(word => word.length > 3);
    if (words.length === 0) return "";
    const placeholders = words.map(() => "content LIKE ?").join(" OR ");
    const params = words.map(word => `%${word}%`);
    // Only fetch messages older than 3 days.
    const extraRows = await dbQuery(
      `SELECT content FROM chat_messages WHERE datetime(timestamp) < datetime('now', '-3 days') AND (${placeholders}) ORDER BY timestamp DESC LIMIT 5`,
      params
    );
    if (extraRows.length > 0) {
      return "\nOlder conversation context:\n" + extraRows.reverse().map(r => r.content).join("\n");
    }
    return "";
  } catch (error) {
    advancedErrorHandler(error, "fetchOlderMemory");
    return "";
  }
}


/********************************************************************
 * DISCORD BOT - Major Section 8: CHAT WITH GEMINI (INCLUDING OCR & WEB)
 ********************************************************************/
// 9.1: Function to chat with Gemini AI – integrates context, mood, preferences, and web search.
async function chatWithGemini(userId, userMessage) {
  try {
    // 9.1.1: Retrieve recent chat history.
    const rows = await dbQuery("SELECT content FROM chat_messages ORDER BY timestamp DESC LIMIT 100");
    const recentChat = rows.reverse().map(r => r.content).join("\n");

    // 9.1.2: Retrieve older memory matching keywords (older than 3 days).
    const olderContext = await fetchOlderMemory(userMessage);

    // 9.1.3: Retrieve user's remembered info.
    const rememberRows = await dbQuery("SELECT * FROM user_remember WHERE user_id = ?", [userId]);
    let rememberedInfo = "";
    if (rememberRows.length > 0) {
      const row = rememberRows[0];
      rememberedInfo = `Remembered Info: Name: ${row.name || "N/A"}, Birthday: ${row.birthday || "N/A"}, Gender: ${row.gender || "N/A"}, Dislikes: ${row.dislikes || "N/A"}, Likes: ${row.likes || "N/A"}, About: ${row.about || "N/A"}.`;
    }

    // 9.1.4: Retrieve user preferences and mood.
    const userRows = await dbQuery("SELECT preferences, username, behavior FROM user_data WHERE user_id = ?", [userId]);
    const userPreferences = userRows[0]?.preferences || "[]";
    const username = userRows[0]?.username || "user";
    const moodRows = await dbQuery("SELECT mood FROM mood_data WHERE user_id = ?", [userId]);
    let userMood = moodRows[0]?.mood || "neutral";
    if (globalCustomMood.enabled && globalCustomMood.mood) {
      userMood = globalCustomMood.mood;
    }
    const moodExtra = moodInstructions[userMood] || "";
    
    // 9.1.5: Analyze tone.
    const tone = analyzeTone(userMessage);

    // 9.1.6: Web search if message starts with "search:".
    let webSearchSection = "";
    if (userMessage.toLowerCase().startsWith("search:")) {
      const searchQuery = userMessage.substring(7).trim();
      const snippet = await performWebSearch(searchQuery);
      webSearchSection = `\nWeb search results for "${searchQuery}": ${snippet}\n`;
      userMessage = searchQuery;
    }

    // 9.1.7: Build the full prompt for Gemini.
    const prompt = `${botBaseInstructions}
${baseBehaviour}
Mood Instructions for "${userMood}":
${moodExtra}
Recent conversation:
${recentChat}
${olderContext}
User (${username}): ${userMessage}
Current mood: ${userMood}
User tone: ${tone}
User preferences: ${userPreferences}
${rememberedInfo}
${webSearchSection}
Reply (be modern, witty, and brutally offensive if appropriate; keep reply under 40 words):`;

    // 9.1.8: Generate response from Gemini.
    const result = await model.generateContent(prompt);
    let reply = (result.response && result.response.text()) || "i'm having a moment, try again.";
    const wordsArr = reply.trim().split(/\s+/);
    if (wordsArr.length > 40) reply = wordsArr.slice(0, 40).join(" ");

    // 9.1.9: Update user data for analytics.
    await dbRun(
      "INSERT OR IGNORE INTO user_data (user_id, username, behavior, preferences) VALUES (?, ?, '{\"interactions\":0}', '[]')",
      [userId, username]
    );
    await dbRun(
      "UPDATE user_data SET behavior = json_set(behavior, '$.interactions', (json_extract(behavior, '$.interactions') + 1)), username = ? WHERE user_id = ?",
      [username, userId]
    );

    return reply;
  } catch (error) {
    advancedErrorHandler(error, "chatWithGemini");
    return "An error occurred while processing your request. Please try again later.";
  }
}


/********************************************************************
 * DISCORD BOT - Major Section 9: MOOD & PREFERENCE MANAGEMENT
 ********************************************************************/
// 10.1: Set the mood for a user.
async function setMood(userId, mood) {
  mood = mood.toLowerCase();
  if (!Object.keys(moodPresetReplies).includes(mood)) {
    return `Invalid mood. Available moods: ${Object.keys(moodPresetReplies).join(", ")}`;
  }
  try {
    await dbRun("INSERT OR IGNORE INTO mood_data (user_id, mood) VALUES (?, ?)", [userId, mood]);
    return moodPresetReplies[mood] || `Mood set to ${mood}`;
  } catch (error) {
    advancedErrorHandler(error, "setMood");
    return "Failed to update mood, please try again later.";
  }
}

// 10.2: Add a new preference for a user.
async function setPreference(userId, newPreference, username) {
  try {
    await dbRun(
      "INSERT OR IGNORE INTO user_data (user_id, username, behavior, preferences) VALUES (?, ?, '{\"interactions\":0}', '[]')",
      [userId, username]
    );
    const rows = await dbQuery("SELECT preferences FROM user_data WHERE user_id = ?", [userId]);
    let prefs = [];
    if (rows[0] && rows[0].preferences) {
      try {
        prefs = JSON.parse(rows[0].preferences);
        if (!Array.isArray(prefs)) prefs = [];
      } catch (e) {
        prefs = [];
      }
    }
    prefs.push(newPreference);
    await dbRun("UPDATE user_data SET preferences = ? WHERE user_id = ?", [JSON.stringify(prefs), userId]);
    return `Preference added: "${newPreference}"`;
  } catch (error) {
    advancedErrorHandler(error, "setPreference");
    return "Failed to update preferences, please try again later.";
  }
}

// 10.3: Remove a specific preference.
async function removePreference(userId, indexToRemove) {
  try {
    const rows = await dbQuery("SELECT preferences FROM user_data WHERE user_id = ?", [userId]);
    let prefs = [];
    if (rows[0] && rows[0].preferences) {
      try {
        prefs = JSON.parse(rows[0].preferences);
        if (!Array.isArray(prefs)) prefs = [];
      } catch (e) {
        prefs = [];
      }
    }
    if (indexToRemove < 0 || indexToRemove >= prefs.length) {
      return { success: false, message: "Invalid preference index." };
    }
    const removed = prefs.splice(indexToRemove, 1)[0];
    await dbRun("UPDATE user_data SET preferences = ? WHERE user_id = ?", [JSON.stringify(prefs), userId]);
    return { success: true, message: `Preference removed: "${removed}"` };
  } catch (error) {
    advancedErrorHandler(error, "removePreference");
    return { success: false, message: "Failed to remove preference, please try again later." };
  }
}

// 10.4: List all preferences for a user.
async function listPreferences(userId) {
  try {
    const rows = await dbQuery("SELECT preferences FROM user_data WHERE user_id = ?", [userId]);
    let prefs = [];
    if (rows[0] && rows[0].preferences) {
      try {
        prefs = JSON.parse(rows[0].preferences);
        if (!Array.isArray(prefs)) prefs = [];
      } catch (e) {
        prefs = [];
      }
    }
    return prefs;
  } catch (error) {
    advancedErrorHandler(error, "listPreferences");
    return [];
  }
}


/********************************************************************
 * DISCORD BOT - Major Section 10: SLASH COMMANDS REGISTRATION
 ********************************************************************/
// 11.1: Define all slash commands.
const commands = [
  { name: "start", description: "Start the bot chatting (server-specific)" },
  { name: "stop", description: "Stop the bot from chatting (server-specific)" },
  {
    name: "setmood",
    description: "Set your mood (user-based)",
    options: [
      { name: "mood", type: 3, description: "Your mood", required: true, choices: Object.keys(moodPresetReplies).map(mood => ({ name: mood, value: mood })) }
    ]
  },
  {
    name: "setpref",
    description: "Add a preference (user-based)",
    options: [
      { name: "preference", type: 3, description: "Your preference", required: true }
    ]
  },
  { name: "prefremove", description: "View and remove your preferences" },
  {
    name: "contreply",
    description: "Enable or disable continuous reply (user-based)",
    options: [
      { name: "mode", type: 3, description: "Choose enable or disable", required: true, choices: [
        { name: "enable", value: "enable" },
        { name: "disable", value: "disable" }
      ] }
    ]
  },
  {
    name: "debug",
    description: "Debug commands (only for authorized user)",
    options: [
      {
        type: 3,
        name: "action",
        description: "Choose a debug action",
        required: true,
        choices: [
          { name: "ping", value: "ping" },
          { name: "restart", value: "restart" },
          { name: "resetmemory", value: "resetmemory" },
          { name: "clearmemory", value: "clearmemory" },
          { name: "getstats", value: "getstats" },
          { name: "listusers", value: "listusers" },
          { name: "globalchat_on", value: "globalchat_on" },
          { name: "globalchat_off", value: "globalchat_off" },
          { name: "globalprefadd", value: "globalprefadd" },
          { name: "globalprefremove", value: "globalprefremove" },
          { name: "log", value: "log" },
          { name: "globalannounce", value: "globalannounce" },
          { name: "status", value: "status" },
          { name: "globalmood", value: "globalmood" },
          { name: "database", value: "database" }
        ]
      },
      { name: "value", type: 3, description: "Optional value for the action", required: false },
      { name: "folder", type: 3, description: "Folder name (for database action)", required: false },
      { name: "server", type: 3, description: "Server ID (for database action)", required: false },
      { name: "channel", type: 3, description: "Channel ID (for database action)", required: false }
    ]
  },
  {
    name: "set",
    description: "Server configuration commands (requires Manage Server/Administrator)",
    options: [
      {
        type: 1,
        name: "channel",
        description: "Set an allowed channel for the bot to talk in"
      },
      {
        type: 1,
        name: "remove",
        description: "Remove a channel from the bot's allowed channels"
      }
    ]
  },
  {
    name: "remember",
    description: "Store your personal info (name, birthday, gender, dislikes, likes, about)",
    options: [
      { name: "name", type: 3, description: "Your name", required: false },
      { name: "birthday", type: 3, description: "Your birthday", required: false },
      { name: "gender", type: 3, description: "Your gender", required: false },
      { name: "dislikes", type: 3, description: "Your dislikes", required: false },
      { name: "likes", type: 3, description: "Your likes", required: false },
      { name: "about", type: 3, description: "About you", required: false }
    ]
  },
  {
    name: "unremember",
    description: "Remove your stored personal info (interactive menu)"
  },
  {
    name: "meme",
    description: "Fetch a meme from Reddit (with 3 fallbacks)",
    options: [
      { name: "keyword", type: 3, description: "Optional search keyword", required: true }
    ]
  },
  {
    name: "gif",
    description: "Fetch a gif from Tenor",
    options: [
      { name: "keyword", type: 3, description: "Optional search keyword", required: false }
    ]
  }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
(async () => {
  try {
    console.log("Started refreshing application (/) commands.");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    advancedErrorHandler(error, "Slash Command Registration");
  }
})();


/********************************************************************
 * DISCORD BOT - Major Section 11: INTERACTION HANDLERS
 ********************************************************************/
// 12.1: Handle slash commands, select menus, and buttons.
client.on("interactionCreate", async (interaction) => {
  try {
    // Global chat off: only allow /debug commands.
    if (!globalChatEnabled && interaction.commandName !== "debug") {
      await interaction.reply({ content: "Global chat is disabled. Only /debug commands are allowed.", ephemeral: true });
      return;
    }
    // For guild commands: if chat is stopped, only /start and /debug are allowed.
    if (interaction.guild && interaction.commandName !== "start" && interaction.commandName !== "debug") {
      const settings = await getGuildSettings(interaction.guild.id);
      if (settings.chat_enabled !== 1) {
        await interaction.reply({ content: "start red first", ephemeral: true });
        return;
      }
    }
    if (interaction.isCommand()) {
      const { commandName } = interaction;
      // Ensure server-only commands are not run in DMs.
      if ((commandName === "start" || commandName === "stop" || commandName === "set") && !interaction.guild) {
        await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
        return;
      }
      if (commandName === "start") {
        const settings = await getGuildSettings(interaction.guild.id);
        if (settings.chat_enabled === 1) {
          const alreadyOnReplies = [
            "i'm already here, genius 💀",
            "you already got me, genius 💀",
            "i'm still around, no need to summon me twice 💀",
            "i'm online, chill out.",
            "i'm here, idiot."
          ];
          await interaction.reply({ content: getRandomElement(alreadyOnReplies), ephemeral: true });
          return;
        }
        await setGuildChat(interaction.guild.id, true);
        await interaction.reply({ content: getRandomElement([
          "alright, i'm awake and ready 🔥",
          "i'm back, let's roll.",
          "yoo, i'm online now.",
          "ready to chat, let's do this."
        ]), ephemeral: true });
      } else if (commandName === "stop") {
        await setGuildChat(interaction.guild.id, false);
        await interaction.reply({ content: "ok, i'm taking a nap 😴", ephemeral: true });
      } else if (commandName === "setmood") {
        const mood = interaction.options.getString("mood").toLowerCase();
        const response = await setMood(interaction.user.id, mood);
        await interaction.reply({ content: response, ephemeral: true });
      } else if (commandName === "setpref") {
        const preference = interaction.options.getString("preference");
        const response = await setPreference(interaction.user.id, preference, interaction.user.username);
        await interaction.reply({ content: response, ephemeral: true });
      } else if (commandName === "prefremove") {
        const prefs = await listPreferences(interaction.user.id);
        if (!prefs || prefs.length === 0) {
          await interaction.reply({ content: "You have no preferences set.", ephemeral: true });
          return;
        }
        const options = prefs.map((pref, index) => {
          const label = pref.length > 25 ? pref.substring(0, 22) + "..." : pref;
          return { label, value: index.toString() };
        });
        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId("prefremove_select")
          .setPlaceholder("Select a preference to remove")
          .addOptions(options);
        const row = new ActionRowBuilder().addComponents(selectMenu);
        await interaction.reply({ content: "Select a preference to remove:", components: [row], ephemeral: true });
      } else if (commandName === "contreply") {
        const mode = interaction.options.getString("mode");
        userContinuousReply.set(interaction.user.id, mode === "enable");
        await interaction.reply({
          content: mode === "enable" 
            ? "Alright, I'll keep replying non-stop for you."
            : "Okay, back to my regular pace.",
          ephemeral: true
        });
      } else if (commandName === "debug") {
        // 12.2: Only allow debug commands for the authorized user (by user ID).
        if (interaction.user.id !== "840119570378784769") {
          await interaction.reply({ content: "Access denied.", ephemeral: true });
          return;
        }
        const action = interaction.options.getString("action");
        const value = interaction.options.getString("value");
        switch (action) {
          case "ping":
            const sent = await interaction.reply({ content: "Pong!", fetchReply: true });
            await interaction.followUp({ content: `Latency: ${sent.createdTimestamp - interaction.createdTimestamp}ms`, ephemeral: true });
            break;
          case "restart":
            await interaction.reply({ content: "Restarting bot...", ephemeral: true });
            process.exit(0);
            break;
          case "resetmemory":
            conversationTracker.clear();
            await interaction.reply({ content: "Conversation memory reset.", ephemeral: true });
            break;
          case "clearmemory": {
            // 12.3: Clear memory command – offer options to clear all guild data or a specific guild.
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId("clearmemory_all")
                .setLabel("Clear All Guild Data")
                .setStyle(ButtonStyle.Danger),
              new ButtonBuilder()
                .setCustomId("clearmemory_select")
                .setLabel("Clear Specific Guild")
                .setStyle(ButtonStyle.Secondary)
            );
            await interaction.reply({ content: "Choose how to clear memory:", components: [row], ephemeral: true });
            break;
          }
          case "getstats": {
            // 12.4: Instead of listing all servers, offer a select menu (search bar simulation) for a specific server.
            const selectMenu = new StringSelectMenuBuilder()
              .setCustomId("getstats_select_menu")
              .setPlaceholder("Search and select a server")
              .addOptions(Array.from(client.guilds.cache.values()).map(guild => ({
                label: guild.name.length > 25 ? guild.name.substring(0,22) + "..." : guild.name,
                value: guild.id
              })));
            const row = new ActionRowBuilder().addComponents(selectMenu);
            await interaction.reply({ content: "Select a server to view its stats:", components: [row], ephemeral: true });
            break;
          }
          case "listusers": {
            try {
              const users = await dbQuery("SELECT username, user_id FROM user_data");
              if (!users || users.length === 0) {
                await interaction.reply({ content: "No users found.", ephemeral: true });
                break;
              }
              const pageSize = 10;
              const totalPages = Math.ceil(users.length / pageSize);
              const page = 1;
              const start = (page - 1) * pageSize;
              const pageUsers = users.slice(start, start + pageSize);
              const userList = pageUsers.map((r, index) => `${start + index + 1}. ${r.username} (${r.user_id})`).join("\n");
              const content = `**Users (Page ${page} of ${totalPages}):**\n` + userList;
              const buttons = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`listusers_prev_${page}`)
                  .setLabel("Previous")
                  .setStyle(ButtonStyle.Primary)
                  .setDisabled(true),
                new ButtonBuilder()
                  .setCustomId(`listusers_next_${page}`)
                  .setLabel("Next")
                  .setStyle(ButtonStyle.Primary)
                  .setDisabled(totalPages <= 1)
              );
              await interaction.reply({ content, components: [buttons], ephemeral: true });
            } catch (error) {
              advancedErrorHandler(error, "List Users");
              await interaction.reply({ content: "An error occurred while retrieving users.", ephemeral: true });
            }
            break;
          }
          case "globalchat_on":
            globalChatEnabled = true;
            await interaction.reply({ content: "Global chat is now ON for all servers.", ephemeral: true });
            break;
          case "globalchat_off":
            globalChatEnabled = false;
            await interaction.reply({ content: "Global chat is now OFF. Only debug commands can be used.", ephemeral: true });
            break;
          case "globalprefadd": {
            if (!value) {
              await interaction.reply({ content: "Please provide a preference value to add.", ephemeral: true });
              return;
            }
            await dbRun("INSERT INTO global_preferences (preference) VALUES (?)", [value]);
            await interaction.reply({ content: `Global preference added: "${value}"`, ephemeral: true });
            break;
          }
          case "globalprefremove": {
            if (value) {
              await dbRun("DELETE FROM global_preferences WHERE preference = ?", [value]);
              await interaction.reply({ content: `Global preference removed: "${value}" (if it existed)`, ephemeral: true });
            } else {
              const rows = await dbQuery("SELECT id, preference FROM global_preferences");
              if (rows.length === 0) {
                await interaction.reply({ content: "No global preferences to remove.", ephemeral: true });
                return;
              }
              const options = rows.map(row => ({
                label: row.preference.length > 25 ? row.preference.substring(0,22) + "..." : row.preference,
                value: row.id.toString()
              }));
              const selectMenu = new StringSelectMenuBuilder()
                .setCustomId("globalprefremove_select")
                .setPlaceholder("Select a global preference to remove")
                .addOptions(options);
              const rowComp = new ActionRowBuilder().addComponents(selectMenu);
              await interaction.reply({ content: "Select a global preference to remove:", components: [rowComp], ephemeral: true });
            }
            break;
          }
          case "log": {
            try {
              const logContent = fs.readFileSync("error.log", "utf8");
              const lines = logContent.trim().split("\n");
              if (lines.length === 0) {
                await interaction.reply({ content: "No logs available.", ephemeral: true });
                break;
              }
              const pageSize = 25;
              const totalPages = Math.ceil(lines.length / pageSize);
              const page = 1;
              const start = (page - 1) * pageSize;
              const pageLines = lines.slice(start, start + pageSize).map((line, index) => `${start + index + 1}. ${line}`);
              const logMessage = `**Error Logs (Page ${page} of ${totalPages}):**\n` + pageLines.join("\n");
              const buttons = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`log_page_prev_${page}`)
                  .setLabel("Previous")
                  .setStyle(ButtonStyle.Primary)
                  .setDisabled(true),
                new ButtonBuilder()
                  .setCustomId(`log_page_next_${page}`)
                  .setLabel("Next")
                  .setStyle(ButtonStyle.Primary)
                  .setDisabled(totalPages <= 1)
              );
              await interaction.reply({ content: logMessage, components: [buttons], ephemeral: true });
            } catch (err) {
              advancedErrorHandler(err, "Debug Log Command");
              await interaction.reply({ content: "An error occurred while retrieving logs.", ephemeral: true });
            }
            break;
          }
          case "globalannounce": {
            if (!value) {
              await interaction.reply({ content: "Please provide an announcement message.", ephemeral: true });
              return;
            }
            client.guilds.cache.forEach(async (guild) => {
              let targetChannel = lastActiveChannel.get(guild.id);
              if (!targetChannel) targetChannel = guild.systemChannel;
              if (targetChannel) {
                try {
                  await targetChannel.send(value);
                } catch (err) {
                  advancedErrorHandler(err, "Global Announcement");
                }
              }
            });
            await interaction.reply({ content: "Global announcement sent.", ephemeral: true });
            break;
          }
          case "status": {
            const statusMsg = `Bot is online.
Global chat: ${globalChatEnabled ? "ON" : "OFF"}.
Global custom mood: ${globalCustomMood.enabled ? globalCustomMood.mood : "disabled"}.`;
            await interaction.reply({ content: statusMsg, ephemeral: true });
            break;
          }
          case "globalmood": {
            if (!value) {
              await interaction.reply({ content: "Please provide 'enable <mood>' or 'disable'.", ephemeral: true });
              return;
            }
            if (value.toLowerCase().startsWith("enable")) {
              const parts = value.split(" ");
              if (parts.length < 2) {
                await interaction.reply({ content: "Please specify a mood to enable.", ephemeral: true });
                return;
              }
              const mood = parts.slice(1).join(" ").toLowerCase();
              if (!Object.keys(moodPresetReplies).includes(mood)) {
                await interaction.reply({ content: `Invalid mood. Available moods: ${Object.keys(moodPresetReplies).join(", ")}`, ephemeral: true });
                return;
              }
              globalCustomMood.enabled = true;
              globalCustomMood.mood = mood;
              await interaction.reply({ content: `Global custom mood enabled: ${mood}`, ephemeral: true });
            } else if (value.toLowerCase() === "disable") {
              globalCustomMood.enabled = false;
              globalCustomMood.mood = null;
              await interaction.reply({ content: "Global custom mood disabled. Using user-based moods.", ephemeral: true });
            } else {
              await interaction.reply({ content: "Invalid value. Use 'enable <mood>' or 'disable'.", ephemeral: true });
            }
            break;
          }
          case "database": {
            try {
              const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                  .setCustomId("database_server_select")
                  .setPlaceholder("Select a server")
                  .addOptions(Array.from(client.guilds.cache.values()).map(guild => ({
                    label: guild.name.length > 25 ? guild.name.substring(0,22) + "..." : guild.name,
                    value: guild.id
                  })))
              );
              await interaction.reply({ content: "Select a server to view its database folders:", components: [row], ephemeral: true });
            } catch (error) {
              advancedErrorHandler(error, "Database Command");
              await interaction.reply({ content: "An error occurred while processing the database command.", ephemeral: true });
            }
            break;
          }
          default:
            await interaction.reply({ content: "Unknown debug command.", ephemeral: true });
            break;
        }
      } else if (commandName === "set") {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) && !interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
          await interaction.reply({ content: "Insufficient permissions. Requires Administrator or Manage Server.", ephemeral: true });
          return;
        }
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === "channel") {
          const channels = interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
          const options = channels.map(ch => ({ label: ch.name, value: ch.id }));
          if (options.length === 0) {
            await interaction.reply({ content: "No text channels available.", ephemeral: true });
            return;
          }
          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId("setchannel_select")
            .setPlaceholder("Select a channel for the bot to talk in")
            .addOptions(options);
          const row = new ActionRowBuilder().addComponents(selectMenu);
          await interaction.reply({ content: "Select a channel to allow the bot to talk in:", components: [row], ephemeral: true });
        } else if (subcommand === "remove") {
          const settings = await getGuildSettings(interaction.guild.id);
          const allowed = settings.allowed_channels;
          if (allowed.length === 0) {
            await interaction.reply({ content: "No channels have been set for the bot.", ephemeral: true });
            return;
          }
          const options = allowed.map(channelId => {
            const channel = interaction.guild.channels.cache.get(channelId);
            return {
              label: channel ? channel.name : channelId,
              value: channelId
            };
          });
          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId("removechannel_select")
            .setPlaceholder("Select a channel to remove from allowed channels")
            .addOptions(options);
          const row = new ActionRowBuilder().addComponents(selectMenu);
          await interaction.reply({ content: "Select a channel to remove:", components: [row], ephemeral: true });
        }
      } else if (commandName === "remember") {
        const fields = ["name", "birthday", "gender", "dislikes", "likes", "about"];
        let updates = {};
        fields.forEach(field => {
          const valueField = interaction.options.getString(field);
          if (valueField) updates[field] = valueField;
        });
        if (Object.keys(updates).length === 0) {
          await interaction.reply({ content: "Please provide at least one field to remember.", ephemeral: true });
          return;
        }
        const existingRows = await dbQuery("SELECT * FROM user_remember WHERE user_id = ?", [interaction.user.id]);
        if (existingRows.length === 0) {
          await dbRun("INSERT INTO user_remember (user_id, name, birthday, gender, dislikes, likes, about) VALUES (?, ?, ?, ?, ?, ?, ?)", [
            interaction.user.id,
            updates.name || null,
            updates.birthday || null,
            updates.gender || null,
            updates.dislikes ? JSON.stringify([updates.dislikes]) : JSON.stringify([]),
            updates.likes ? JSON.stringify([updates.likes]) : JSON.stringify([]),
            updates.about ? JSON.stringify([updates.about]) : JSON.stringify([])
          ]);
        } else {
          const row = existingRows[0];
          for (const field in updates) {
            if (["likes", "dislikes", "about"].includes(field)) {
              let arr = [];
              try {
                arr = JSON.parse(row[field] || "[]");
                if (!Array.isArray(arr)) arr = [];
              } catch (e) {
                arr = [];
              }
              arr.push(updates[field]);
              await dbRun(`UPDATE user_remember SET ${field} = ? WHERE user_id = ?`, [JSON.stringify(arr), interaction.user.id]);
            } else {
              await dbRun(`UPDATE user_remember SET ${field} = ? WHERE user_id = ?`, [updates[field], interaction.user.id]);
            }
          }
        }
        await interaction.reply({ content: "Your personal info has been remembered.", ephemeral: true });
      } else if (commandName === "unremember") {
        // 12.5: Unremember command – if a field contains an array with multiple items, show a select menu for specific deletion.
        const rowData = await dbQuery("SELECT * FROM user_remember WHERE user_id = ?", [interaction.user.id]);
        if (rowData.length === 0) {
          await interaction.reply({ content: "You have no remembered info.", ephemeral: true });
          return;
        }
        const data = rowData[0];
        let options = [];
        for (const field of ["name", "birthday", "gender", "dislikes", "likes", "about"]) {
          if (data[field]) {
            try {
              // Try parsing as JSON array.
              let parsed = JSON.parse(data[field]);
              if (Array.isArray(parsed) && parsed.length > 1) {
                // Create an option for each item.
                parsed.forEach((item, idx) => {
                  options.push({ label: `${field}[${idx}]: ${item}`, value: `${field}_${idx}` });
                });
              } else {
                // Single value or array with one element.
                options.push({ label: `${field}: ${data[field]}`, value: field });
              }
            } catch (e) {
              options.push({ label: `${field}: ${data[field]}`, value: field });
            }
          }
        }
        if (options.length === 0) {
          await interaction.reply({ content: "Nothing to unremember.", ephemeral: true });
          return;
        }
        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId("unremember_select")
          .setPlaceholder("Select a field/item to remove")
          .addOptions(options);
        const row = new ActionRowBuilder().addComponents(selectMenu);
        await interaction.reply({ content: "Select a field/item to remove from your remembered info:", components: [row], ephemeral: true });
      } else if (commandName === "meme") {
        const keyword = interaction.options.getString("keyword") || "funny";
        const memeObj = await getRandomMeme(keyword);
        await interaction.reply({ content: memeObj.url });
        await storeMedia("meme", memeObj.url, memeObj.name);
      } else if (commandName === "gif") {
        const keyword = interaction.options.getString("keyword") || "funny";
        const gifObj = await getRandomGif(keyword);
        await interaction.reply({ content: gifObj.url });
        await storeMedia("gif", gifObj.url, gifObj.name);
      }
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "prefremove_select") {
        const selectedIndex = parseInt(interaction.values[0], 10);
        const prefs = await listPreferences(interaction.user.id);
        if (!prefs || selectedIndex < 0 || selectedIndex >= prefs.length) {
          await interaction.update({ content: "Invalid selection.", components: [] });
          return;
        }
        const removed = await removePreference(interaction.user.id, selectedIndex);
        await interaction.update({ content: removed.message, components: [] });
      } else if (interaction.customId === "globalprefremove_select") {
        const selectedId = parseInt(interaction.values[0], 10);
        await dbRun("DELETE FROM global_preferences WHERE id = ?", [selectedId]);
        await interaction.update({ content: "Global preference removed.", components: [] });
      } else if (interaction.customId === "setchannel_select") {
        const selectedChannelId = interaction.values[0];
        const settings = await getGuildSettings(interaction.guild.id);
        let allowed = settings.allowed_channels;
        if (!allowed.includes(selectedChannelId)) {
          allowed.push(selectedChannelId);
          await updateGuildAllowedChannels(interaction.guild.id, allowed);
          await interaction.update({ content: `Channel <#${selectedChannelId}> added to allowed channels.`, components: [] });
        } else {
          await interaction.update({ content: "Channel is already in the allowed list.", components: [] });
        }
      } else if (interaction.customId === "removechannel_select") {
        const selectedChannelId = interaction.values[0];
        const settings = await getGuildSettings(interaction.guild.id);
        let allowed = settings.allowed_channels;
        if (allowed.includes(selectedChannelId)) {
          allowed = allowed.filter(id => id !== selectedChannelId);
          await updateGuildAllowedChannels(interaction.guild.id, allowed);
          await interaction.update({ content: `Channel <#${selectedChannelId}> removed from allowed channels.`, components: [] });
        } else {
          await interaction.update({ content: "Channel not found in the allowed list.", components: [] });
        }
      } else if (interaction.customId === "unremember_select") {
        const value = interaction.values[0];
        if (value.includes("_")) {
          // value in format field_index, so remove specific array item.
          const [field, indexStr] = value.split("_");
          const index = parseInt(indexStr, 10);
          const rowData = await dbQuery("SELECT * FROM user_remember WHERE user_id = ?", [interaction.user.id]);
          if (rowData.length === 0) {
            await interaction.update({ content: "No remembered info found.", components: [] });
            return;
          }
          let fieldData;
          try {
            fieldData = JSON.parse(rowData[0][field]);
          } catch (e) {
            fieldData = [rowData[0][field]];
          }
          if (!Array.isArray(fieldData) || index < 0 || index >= fieldData.length) {
            await interaction.update({ content: "Invalid selection.", components: [] });
            return;
          }
          fieldData.splice(index, 1);
          await dbRun(`UPDATE user_remember SET ${field} = ? WHERE user_id = ?`, [JSON.stringify(fieldData), interaction.user.id]);
          await interaction.update({ content: `Removed item ${index} from ${field}.`, components: [] });
        } else {
          // Single value removal.
          await dbRun(`UPDATE user_remember SET ${interaction.values[0]} = NULL WHERE user_id = ?`, [interaction.user.id]);
          await interaction.update({ content: `Removed your ${interaction.values[0]} from remembered info.`, components: [] });
        }
      } else if (interaction.customId === "database_server_select") {
        try {
          const serverId = interaction.values[0];
          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`database_folder_select_${serverId}`)
            .setPlaceholder("Select a database folder")
            .addOptions([
              { label: "Chat Messages", value: "chat_messages" },
              { label: "User Data", value: "user_data" },
              { label: "Mood Data", value: "mood_data" },
              { label: "Server Settings", value: "server_settings" },
              { label: "Global Preferences", value: "global_preferences" },
              { label: "User Remember", value: "user_remember" },
              { label: "Media Library", value: "media_library" }
            ]);
          const row = new ActionRowBuilder().addComponents(selectMenu);
          await interaction.update({ content: "Select a database folder to view its data:", components: [row] });
        } catch (error) {
          advancedErrorHandler(error, "Database Server Selection");
          await interaction.reply({ content: "An error occurred during server selection.", ephemeral: true });
        }
      } else if (interaction.customId.startsWith("database_folder_select_")) {
        try {
          const serverId = interaction.customId.split("_").pop();
          const folder = interaction.values[0];
          const pageSize = 25;
          const page = 1;
          let rows = [];
          if (folder === "server_settings") {
            rows = await dbQuery("SELECT * FROM server_settings WHERE guild_id = ?", [serverId]);
          } else if (folder === "chat_messages") {
            const guild = client.guilds.cache.get(serverId);
            const textChannels = guild.channels.cache.filter(ch => ch.type === ChannelType.GuildText);
            const channelIds = Array.from(textChannels.keys());
            if (channelIds.length > 0) {
              const placeholders = channelIds.map(() => "?").join(",");
              rows = await dbQuery(`SELECT * FROM chat_messages WHERE channel_id IN (${placeholders}) ORDER BY timestamp DESC`, channelIds);
            }
          } else {
            rows = await dbQuery(`SELECT * FROM ${folder}`);
          }
          if (!rows || rows.length === 0) {
            await interaction.update({ content: "No data found in the selected folder.", components: [] });
            return;
          }
          const totalPages = Math.ceil(rows.length / pageSize);
          const start = (page - 1) * pageSize;
          const pageRows = rows.slice(start, start + pageSize);
          let content = `**Data from ${folder} (Page ${page} of ${totalPages}):**\n`;
          pageRows.forEach((row, index) => {
            content += `${start + index + 1}. ${JSON.stringify(row)}\n`;
          });
          const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`database_prev_${folder}_${serverId}_${page}`)
              .setLabel("Previous")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId(`database_next_${folder}_${serverId}_${page}`)
              .setLabel("Next")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(page === totalPages)
          );
          await interaction.update({ content, components: [buttons] });
        } catch (error) {
          advancedErrorHandler(error, "Database Folder Selection");
          await interaction.reply({ content: "An error occurred while retrieving folder data.", ephemeral: true });
        }
      } else if (interaction.customId === "clearmemory_select") {
        // Handle selection for clearing memory for a specific guild.
        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId("clearmemory_guild_select")
          .setPlaceholder("Select a guild to clear memory")
          .addOptions(Array.from(client.guilds.cache.values()).map(guild => ({
            label: guild.name.length > 25 ? guild.name.substring(0,22) + "..." : guild.name,
            value: guild.id
          })));
        const row = new ActionRowBuilder().addComponents(selectMenu);
        await interaction.update({ content: "Select a guild to clear its database memory:", components: [row] });
      } else if (interaction.customId === "clearmemory_all") {
        // Clear memory for all guilds.
        await dbRun("DELETE FROM chat_messages");
        await dbRun("DELETE FROM server_settings");
        await interaction.update({ content: "Cleared database memory for all guilds.", components: [] });
      } else if (interaction.customId === "clearmemory_guild_select") {
        const guildId = interaction.values[0];
        await dbRun("DELETE FROM chat_messages WHERE channel_id IN (SELECT channel_id FROM chat_messages WHERE channel_id IN (SELECT id FROM channels WHERE guild_id = ?))", [guildId])
          .catch(() => {}); // In case of error, ignore.
        await dbRun("DELETE FROM server_settings WHERE guild_id = ?", [guildId]);
        await interaction.update({ content: `Cleared database memory for guild ${guildId}.`, components: [] });
      } else if (interaction.customId.startsWith("log_page_prev_") || interaction.customId.startsWith("log_page_next_")) {
        try {
          const parts = interaction.customId.split("_");
          const direction = parts[2];
          let currentPage = parseInt(parts[3], 10);
          const logContent = fs.readFileSync("error.log", "utf8");
          const lines = logContent.trim().split("\n");
          const pageSize = 25;
          const totalPages = Math.ceil(lines.length / pageSize);
          if (direction === "next") {
            currentPage = Math.min(currentPage + 1, totalPages);
          } else if (direction === "prev") {
            currentPage = Math.max(currentPage - 1, 1);
          }
          const start = (currentPage - 1) * pageSize;
          const pageLines = lines.slice(start, start + pageSize).map((line, index) => `${start + index + 1}. ${line}`);
          const logMessage = `**Error Logs (Page ${currentPage} of ${totalPages}):**\n` + pageLines.join("\n");
          const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`log_page_prev_${currentPage}`)
              .setLabel("Previous")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(currentPage === 1),
            new ButtonBuilder()
              .setCustomId(`log_page_next_${currentPage}`)
              .setLabel("Next")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(currentPage === totalPages)
          );
          await interaction.update({ content: logMessage, components: [buttons] });
        } catch (error) {
          advancedErrorHandler(error, "Log Pagination Button");
          await interaction.reply({ content: "An error occurred while updating logs.", ephemeral: true });
        }
      } else if (interaction.customId.startsWith("listusers_prev_") || interaction.customId.startsWith("listusers_next_")) {
        try {
          const parts = interaction.customId.split("_");
          let currentPage = parseInt(parts[2], 10);
          const users = await dbQuery("SELECT username, user_id FROM user_data");
          const pageSize = 10;
          const totalPages = Math.ceil(users.length / pageSize);
          if (interaction.customId.startsWith("listusers_next_")) {
            currentPage = Math.min(currentPage + 1, totalPages);
          } else {
            currentPage = Math.max(currentPage - 1, 1);
          }
          const start = (currentPage - 1) * pageSize;
          const pageUsers = users.slice(start, start + pageSize);
          const userList = pageUsers.map((r, index) => `${start + index + 1}. ${r.username} (${r.user_id})`).join("\n");
          const content = `**Users (Page ${currentPage} of ${totalPages}):**\n` + userList;
          const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`listusers_prev_${currentPage}`)
              .setLabel("Previous")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(currentPage === 1),
            new ButtonBuilder()
              .setCustomId(`listusers_next_${currentPage}`)
              .setLabel("Next")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(currentPage === totalPages)
          );
          await interaction.update({ content, components: [buttons] });
        } catch (error) {
          advancedErrorHandler(error, "List Users Pagination");
          await interaction.reply({ content: "An error occurred while updating users list.", ephemeral: true });
        }
      } else if (interaction.customId === "getstats_select_menu") {
        try {
          const serverId = interaction.values[0];
          const guild = client.guilds.cache.get(serverId);
          if (!guild) {
            await interaction.update({ content: "Server not found.", components: [] });
            return;
          }
          // 12.6: Retrieve server profile picture (using dynamic option), member count, and unique chat participants.
          const profilePic = guild.iconURL({ dynamic: true }) || "No profile picture.";
          const totalMembers = guild.memberCount || "N/A";
          let activeUsers = 0;
          conversationTracker.forEach((data, channelId) => {
            const channel = client.channels.cache.get(channelId);
            if (channel && channel.guild && channel.guild.id === guild.id) {
              activeUsers += data.participants.size;
            }
          });
          const textChannels = guild.channels.cache.filter(ch => ch.type === ChannelType.GuildText);
          const channelIds = Array.from(textChannels.keys());
          let totalInteracted = "N/A";
          if (channelIds.length > 0) {
            const placeholders = channelIds.map(() => "?").join(",");
            const rows = await dbQuery(`SELECT COUNT(DISTINCT user) as count FROM chat_messages WHERE channel_id IN (${placeholders})`, channelIds);
            totalInteracted = rows[0]?.count || 0;
          }
          const statsMessage = `**Server Stats for ${guild.name}:**
Profile Picture: ${profilePic}
Total Members: ${totalMembers}
Active Users Talking Now: ${activeUsers}
Total Unique Users (All Time): ${totalInteracted}`;
          await interaction.update({ content: statsMessage, components: [] });
        } catch (error) {
          advancedErrorHandler(error, "GetStats Server Details");
          await interaction.reply({ content: "An error occurred while retrieving server stats.", ephemeral: true });
        }
      }
    } else if (interaction.isButton()) {
      const customId = interaction.customId;
      // Handle clear memory buttons.
      if (customId === "clearmemory_all" || customId === "clearmemory_select") {
        // Already handled above.
      } else if (customId.startsWith("log_page_prev_") || customId.startsWith("log_page_next_")) {
        // Already handled above.
      } else if (customId.startsWith("listusers_prev_") || customId.startsWith("listusers_next_")) {
        // Already handled above.
      }
    }
  } catch (error) {
    advancedErrorHandler(error, "Interaction Handler");
    try {
      if (!interaction.replied) {
        await interaction.reply({ content: "An error occurred while processing your request. Please try again later.", ephemeral: true });
      }
    } catch (err) {
      advancedErrorHandler(err, "Interaction Error Reply");
    }
  }
});


/********************************************************************
 * DISCORD BOT - Major Section 12: MESSAGE HANDLER (INCLUDING OCR)
 ********************************************************************/
// 13.1: Handle incoming messages and trigger responses.
client.on("messageCreate", async (message) => {
  try {
    // 13.2: Update last active channel.
    if (message.guild && message.channel.type === ChannelType.GuildText) {
      lastActiveChannel.set(message.guild.id, message.channel);
    }
    // 13.3: Process attachments for OCR if images are sent.
    if (message.attachments.size > 0) {
      for (const attachment of message.attachments.values()) {
        if (attachment.contentType && attachment.contentType.startsWith("image/")) {
          const ocrResult = await performOCR(attachment.url);
          if (ocrResult) {
            // Append OCR text to message content for context.
            message.content += `\n[OCR]: ${ocrResult}`;
          }
        }
      }
    }
    if (!globalChatEnabled) return;
    await dbRun("INSERT INTO chat_messages (discord_id, channel_id, user, content) VALUES (?, ?, ?, ?)", [message.id, message.channel.id, message.author.id, message.content]);
    if (message.author.id === client.user.id) return;
    if (message.guild) {
      const settings = await getGuildSettings(message.guild.id);
      if (settings.chat_enabled !== 1) return;
      if (settings.allowed_channels.length > 0 && !settings.allowed_channels.includes(message.channel.id)) return;
    }
    // 13.4: Trigger meme/gif sending if keywords found.
    const triggers = ["meme", "funny", "gif"];
    if (triggers.some(t => message.content.toLowerCase().includes(t)) && Math.random() < 0.30) {
      const searchTerm = lastBotMessageContent ? lastBotMessageContent.split(" ").slice(0, 3).join(" ") : "funny";
      if (Math.random() < 0.5) {
        const memeObj = await getRandomMeme(searchTerm);
        try {
          await message.channel.send({ content: memeObj.url });
          await storeMedia("meme", memeObj.url, memeObj.name);
        } catch (err) {
          advancedErrorHandler(err, "Sending Meme");
        }
      } else {
        const gifObj = await getRandomGif(searchTerm);
        try {
          await message.channel.send({ content: gifObj.url });
          await storeMedia("gif", gifObj.url, gifObj.name);
        } catch (err) {
          advancedErrorHandler(err, "Sending Gif");
        }
      }
      return;
    }
    if (!shouldReply(message)) return;
    const replyContent = await chatWithGemini(message.author.id, message.content);
    if (replyContent === lastReply) return;
    lastReply = replyContent;
    try {
      const sentMsg = await message.channel.send(replyContent);
      lastBotMessageContent = replyContent;
      botMessageIds.add(sentMsg.id);
      setTimeout(() => botMessageIds.delete(sentMsg.id), 3600000);
    } catch (err) {
      advancedErrorHandler(err, "Sending Reply");
    }
  } catch (error) {
    advancedErrorHandler(error, "Message Handler");
  }
});


/********************************************************************
 * DISCORD BOT - Minor Section 3: READY EVENT & ROLE ASSIGNMENT
 ********************************************************************/
// 14.1: On ready, assign a default role to the bot in every guild.
client.once("ready", async () => {
  console.log("sir, bot is online!");
  client.guilds.cache.forEach(async (guild) => {
    try {
      const roleName = "superior walmart bag 🗿";
      let role = guild.roles.cache.find(r => r.name === roleName);
      if (!role) {
        role = await guild.roles.create({
          name: roleName,
          color: "#FF0000",
          reason: "Auto-created role for the bot"
        });
      }
      const botMember = guild.members.cache.get(client.user.id);
      if (botMember && !botMember.roles.cache.has(role.id)) {
        await botMember.roles.add(role);
        console.log(`Assigned ${roleName} role in guild "${guild.name}"`);
      }
    } catch (error) {
      console.error(`Error in guild "${guild.name}":`, error);
    }
  });
});


/********************************************************************
 * DISCORD BOT - Major Section 13: EXPRESS SERVER FOR UPTIME MONITORING
 ********************************************************************/
// 15.1: Set up a simple express server to keep the bot alive.
const app = express();
app.get("/", (req, res) => res.send("noobhay tripathi is alive! 🚀"));
app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));


/********************************************************************
 * DISCORD BOT - Minor Section 4: AUTO-RETRY LOGIN FUNCTIONALITY
 ********************************************************************/
// 16.1: Continuously try logging in until successful.
async function startBot() {
  while (true) {
    try {
      await client.login(DISCORD_TOKEN);
      break;
    } catch (error) {
      advancedErrorHandler(error, "Login");
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
}

startBot();
