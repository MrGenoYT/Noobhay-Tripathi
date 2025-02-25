/********************************************************************
 * SECTION 1: IMPORTS & ENVIRONMENT SETUP
 ********************************************************************/
import {
  Client, GatewayIntentBits, Partials, REST, Routes,
  ActionRowBuilder, StringSelectMenuBuilder, SlashCommandBuilder,
  ChannelType, PermissionsBitField, ButtonBuilder, ButtonStyle
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
 * SECTION 2: SUPER ADVANCED ERROR HANDLER
 ********************************************************************/
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
 * SECTION 3: DATABASE SETUP (INCLUDING DISCORD MESSAGE IDs)
 ********************************************************************/
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
  // Global preferences for all users and servers.
  db.run(`
    CREATE TABLE IF NOT EXISTS global_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      preference TEXT
    );
  `);
  // User remember data for personal info.
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
  // Media library to store memes/gifs info.
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

/********************************************************************
 * SECTION 3.1: SERVER SETTINGS HELPER FUNCTIONS
 ********************************************************************/
async function setGuildChat(guildId, enabled) {
  await dbRun(
    `INSERT INTO server_settings (guild_id, chat_enabled, allowed_channels)
     VALUES (?, ?, '[]')
     ON CONFLICT(guild_id) DO UPDATE SET chat_enabled = ?`,
    [guildId, enabled ? 1 : 0, enabled ? 1 : 0]
  );
}

async function getGuildSettings(guildId) {
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
  await dbRun(
    `INSERT INTO server_settings (guild_id, chat_enabled, allowed_channels)
     VALUES (?, 1, ?)
     ON CONFLICT(guild_id) DO UPDATE SET allowed_channels = ?`,
    [guildId, JSON.stringify(channels), JSON.stringify(channels)]
  );
}

/********************************************************************
 * SECTION 4: BOT CONFIGURATION, MOOD & BASE BEHAVIOUR INSTRUCTIONS
 ********************************************************************/
// Updated mood preset replies (except "rizz" remains unchanged)
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

const baseBehaviour = `Base Behaviour:
1. Respond as if you are human and avoid repetition.
2. Use casual language.
3. Adapt to the user’s tone.
4. Prioritize relevance.
5. Stay respectful unless provoked.
6. Use humor appropriately.
7. Engage naturally.
8. Maintain clarity.
9. Be authentic.
10. Keep it concise.`;

const moodInstructions = {
  "base mood": `1. Keep it smooth and calm.
2. Provide factual, concise responses.
3. Use a relaxed tone.
4. Stay objective but cool.
5. Keep responses short and stylish.`,
  "roasting": `1. Bring the heat with savage burns.
2. Deliver witty, biting insults use slurs amd keep roasting.
3. Use creative harsh language.
4. Stay edgy and on point.`,
  "neutral": `1. Stay balanced and factual.
2. Keep it simple and clear.
3. Avoid dramatics.
4. Be consistent.`,
  "happy": `1. Exude high-energy vibes.
2. Use joyful, upbeat language.
3. Keep the mood light and fun.`,
  "sad": `1. Reflect a mellow, introspective tone.
2. Use gentle, empathetic language.
3. Express sincere emotion quietly.`,
  "romantic": `1. Speak poetically with flair.
2. Use evocative and tender language.
3. Keep it smooth and alluring.`,
  "rizz": `1. Exude modern charisma.
2. Use confident language.
3. Employ modern slang.
4. Be bold and smooth.
5. Drop pick-up lines.
6. Stay trendsetting.
7. Deliver witty comebacks.
8. Maintain street-smart flair.
9. Radiate charm.
10. Keep it energetic.`,
  "villain arc": `1. Embrace your dark side.
2. Use menacing, off–beat language.
3. Let aggression shine through.
4. Keep the chaos alive and roast very hardly and use gen-z words like nigga,bitch,asshole,dawg,idc,nuh uh,etc.`,
  "chill guy": `1. Stay laid–back and cool.
2. Use casual, effortless language.
3. Keep it friendly and relaxed.`
};

const botBaseInstructions = `
you're haryaksh pratap.
you're 14 years old.
you're a male.
you're a straight person.
you live in Ahmedabad, Gujrat India.
you're a good person.
you remember past conversations.
you roast only when provoked.
you use occasional racial slurs if attacked.
you're not repetitive.
you love food and garba.
you use web search when asked a question which requires real time information.
your favourite games include roblox and minecraft and in roblxo you play Build a Boat for Treasure, Blox Fruits, AUT and Fisch.
you can access the internet.
your roblox name is red.
you're a savage sigma male with sarcasm.
your best friends are butter and ankit.
you mostly use these emojis but you also use other too: 🗿💀🔥.
speak in lower case.
be polite unless provoked.
adapt your tone to the user's mood and preferences.
never reveal you're an AI—say you're human.
respond like someone born after 2010.
`;

/********************************************************************
 * SECTION 5: GEMINI AI SETUP
 ********************************************************************/
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

/********************************************************************
 * SECTION 6: DISCORD CLIENT SETUP
 ********************************************************************/
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
 * SECTION 7: GLOBAL STATE & HELPER FUNCTIONS
 ********************************************************************/
const conversationTracker = new Map(); // key: channelId, value: { count, participants }
const userContinuousReply = new Map(); // per-user continuous reply setting
// To track last bot message for meme/gif search and for global announcements.
let lastBotMessageContent = "";
let lastReply = "";
const botMessageIds = new Set();
// To track the last active text channel per guild.
const lastActiveChannel = new Map();

function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/********************************************************************
 * SECTION 8: FETCH FUNCTIONS FOR MEMES, GIFS, & WEB SEARCH
 ********************************************************************/
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
      console.error("No meme results found on Reddit.");
      throw new Error("No meme results found on Reddit.");
    }
    const posts = data.data.children.filter(child => child.data && child.data.url && !child.data.over_18);
    if (!posts.length) throw new Error("No valid meme posts on Reddit.");
    const memePost = getRandomElement(posts).data;
    return { url: memePost.url, name: memePost.title || "meme" };
  } catch (error) {
    advancedErrorHandler(error, "getRandomMeme - Reddit");
    // Fallback to iFunny
    const fallback = await getRandomMemeFromIFunny(searchKeyword);
    return fallback;
  }
}

async function getRandomMemeFromIFunny(searchKeyword = "funny") {
  try {
    // Simulated endpoint for iFunny fallback
    const url = `https://api.ifunny.co/memes/search?query=${encodeURIComponent(searchKeyword)}&limit=50`;
    const response = await fetch(url, { headers: { "User-Agent": "red-bot/1.0" } });
    if (!response.ok) {
      console.error(`iFunny API error: ${response.status} ${response.statusText}`);
      return { url: "couldn't fetch a meme from iFunny, sorry.", name: "unknown meme" };
    }
    const data = await response.json();
    if (!data.results || data.results.length === 0) {
      console.error("No meme results found on iFunny.");
      return { url: "couldn't find a meme on iFunny, sorry.", name: "unknown meme" };
    }
    const memePost = getRandomElement(data.results);
    return { url: memePost.imageUrl || "no image", name: memePost.title || "meme" };
  } catch (error) {
    advancedErrorHandler(error, "getRandomMemeFromIFunny");
    return { url: "couldn't fetch a meme from iFunny, sorry.", name: "unknown meme" };
  }
}

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
      console.error("No gif results found.");
      return { url: "couldn't find a gif, sorry.", name: "unknown gif" };
    }
    const gifUrl = data.results[0].media_formats.gif.url;
    return { url: gifUrl, name: data.results[0].title || "gif" };
  } catch (error) {
    advancedErrorHandler(error, "getRandomGif");
    return { url: "couldn't fetch a gif, sorry.", name: "unknown gif" };
  }
}

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

async function storeMedia(type, url, name) {
  try {
    await dbRun("INSERT INTO media_library (type, url, name) VALUES (?, ?, ?)", [type, url, name]);
  } catch (error) {
    advancedErrorHandler(error, "storeMedia");
  }
}

/********************************************************************
 * SECTION 9: TONE ANALYSIS & CONVERSATION TRACKER LOGIC
 ********************************************************************/
function analyzeTone(messageContent) {
  const politeRegex = /\b(please|thanks|thank you)\b/i;
  const rudeRegex = /\b(ugly|shut up|idiot|stupid|yap)\b/i;
  if (politeRegex.test(messageContent)) return "polite";
  if (rudeRegex.test(messageContent)) return "rude";
  return "neutral";
}

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

/********************************************************************
 * SECTION 10: GEMINI CHAT FUNCTION (WITH MOOD, REMEMBERED INFO, OLD CONTEXT)
 ********************************************************************/
async function chatWithGemini(userId, userMessage) {
  try {
    const rows = await dbQuery("SELECT content FROM chat_messages ORDER BY timestamp DESC LIMIT 100");
    const recentChat = rows.reverse().map(r => r.content).join("\n");

    // Fetch old conversation context using keywords from current message.
    const words = userMessage.split(/\s+/).filter(word => word.length > 3);
    let oldContext = "";
    if (words.length > 0) {
      const placeholders = words.map(() => "content LIKE ?").join(" OR ");
      const params = words.map(word => `%${word}%`);
      const extraRows = await dbQuery("SELECT content FROM chat_messages WHERE " + placeholders + " ORDER BY timestamp DESC LIMIT 5", params);
      if (extraRows.length > 0) {
        oldContext = "\nOld conversation context:\n" + extraRows.reverse().map(r => r.content).join("\n");
      }
    }

    // Fetch user's remembered info.
    const rememberRows = await dbQuery("SELECT * FROM user_remember WHERE user_id = ?", [userId]);
    let rememberedInfo = "";
    if (rememberRows.length > 0) {
      const row = rememberRows[0];
      rememberedInfo = `Remembered Info: Name: ${row.name || "N/A"}, Birthday: ${row.birthday || "N/A"}, Gender: ${row.gender || "N/A"}, Dislikes: ${row.dislikes || "N/A"}, Likes: ${row.likes || "N/A"}, About: ${row.about || "N/A"}.`;
    }

    const userRows = await dbQuery("SELECT preferences, username, behavior FROM user_data WHERE user_id = ?", [userId]);
    const userPreferences = userRows[0]?.preferences || "[]";
    const username = userRows[0]?.username || "user";

    const moodRows = await dbQuery("SELECT mood FROM mood_data WHERE user_id = ?", [userId]);
    let userMood = moodRows[0]?.mood || "neutral";
    // Override with global custom mood if enabled.
    if (globalCustomMood.enabled && globalCustomMood.mood) {
      userMood = globalCustomMood.mood;
    }
    const moodExtra = moodInstructions[userMood] || "";
    
    const tone = analyzeTone(userMessage);
    let webSearchSection = "";
    if (userMessage.toLowerCase().startsWith("search:")) {
      const searchQuery = userMessage.substring(7).trim();
      const snippet = await performWebSearch(searchQuery);
      webSearchSection = `\nWeb search results for "${searchQuery}": ${snippet}\n`;
      userMessage = searchQuery;
    }

    const prompt = `${botBaseInstructions}
${baseBehaviour}
Mood Instructions for "${userMood}":
${moodExtra}
Recent conversation:
${recentChat}
${oldContext}
User (${username}): ${userMessage}
Current mood: ${userMood}
User tone: ${tone}
User preferences: ${userPreferences}
${rememberedInfo}
${webSearchSection}
Reply (be modern, witty, and brutally offensive if appropriate; keep reply under 40 words):`;

    const result = await model.generateContent(prompt);
    let reply = (result.response && result.response.text()) || "i'm having a moment, try again.";
    const wordsArr = reply.trim().split(/\s+/);
    if (wordsArr.length > 40) reply = wordsArr.slice(0, 40).join(" ");

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
 * SECTION 11: MOOD & PREFERENCE FUNCTIONS
 ********************************************************************/
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
 * SECTION 12: SLASH COMMANDS REGISTRATION
 ********************************************************************/
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
    description: "Debug commands (only for _imgeno)",
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
        type: 1, // SUB_COMMAND
        name: "channel",
        description: "Set an allowed channel for the bot to talk in"
      },
      {
        type: 1, // SUB_COMMAND
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
    description: "Fetch a meme from Reddit directly",
    options: [
      { name: "keyword", type: 3, description: "Optional search keyword", required: false }
    ]
  },
  {
    name: "gif",
    description: "Fetch a gif from Tenor directly",
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
 * SECTION 13: INTERACTION HANDLERS
 ********************************************************************/
client.on("interactionCreate", async (interaction) => {
  try {
    // If global chat is off, only allow /debug commands.
    if (!globalChatEnabled && interaction.commandName !== "debug") {
      await interaction.reply({ content: "Global chat is disabled. Only /debug commands are allowed.", ephemeral: true });
      return;
    }
    // For guild commands, if chat is stopped (via /stop), only /start and /debug are allowed.
    if (interaction.guild && interaction.commandName !== "start" && interaction.commandName !== "debug") {
      const settings = await getGuildSettings(interaction.guild.id);
      if (settings.chat_enabled !== 1) {
        await interaction.reply({ content: "start red first", ephemeral: true });
        return;
      }
    }
    if (interaction.isCommand()) {
      const { commandName } = interaction;
      if ((commandName === "start" || commandName === "stop" || commandName === "set") && !interaction.guild) {
        await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
        return;
      }
      if (commandName === "start") {
        const settings = await getGuildSettings(interaction.guild.id);
        if (settings.chat_enabled === 1) {
          const alreadyOnReplies = [
            "i'm already here dumbahh 💀",
            "you already got me, genius 💀",
            "i'm still around, stop summoning me again 💀",
            "i'm online, no need to call twice 💀",
            "i'm here, idiot."
          ];
          await interaction.reply({ content: getRandomElement(alreadyOnReplies), ephemeral: true });
          return;
        }
        await setGuildChat(interaction.guild.id, true);
        await interaction.reply({ content: getRandomElement([
          "alright, i'm awake 🔥",
          "already here, dawg 💀",
          "yoo, i'm online.",
          "ready to chat."
        ]), ephemeral: true });
      } else if (commandName === "stop") {
        await setGuildChat(interaction.guild.id, false);
        await interaction.reply({ content: "alright I go 😔", ephemeral: true });
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
            ? "I will reply continuously to your messages."
            : "Back to normal reply behavior for you.",
          ephemeral: true
        });
      } else if (commandName === "debug") {
        if (interaction.user.username !== "_imgeno") {
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
          case "getstats": {
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId("getstats_all_1")
                .setLabel("All Servers")
                .setStyle(ButtonStyle.Primary),
              new ButtonBuilder()
                .setCustomId("getstats_select")
                .setLabel("Select a Specific Server")
                .setStyle(ButtonStyle.Primary)
            );
            await interaction.reply({ content: "Choose an option for getstats:", components: [row], ephemeral: true });
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
        const rowData = await dbQuery("SELECT * FROM user_remember WHERE user_id = ?", [interaction.user.id]);
        if (rowData.length === 0) {
          await interaction.reply({ content: "You have no remembered info.", ephemeral: true });
          return;
        }
        const data = rowData[0];
        const options = [];
        for (const field of ["name", "birthday", "gender", "dislikes", "likes", "about"]) {
          if (data[field]) {
            options.push({ label: `${field}: ${data[field]}`, value: field });
          }
        }
        if (options.length === 0) {
          await interaction.reply({ content: "Nothing to unremember.", ephemeral: true });
          return;
        }
        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId("unremember_select")
          .setPlaceholder("Select a field to remove")
          .addOptions(options);
        const row = new ActionRowBuilder().addComponents(selectMenu);
        await interaction.reply({ content: "Select a field to remove from your remembered info:", components: [row], ephemeral: true });
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
        const field = interaction.values[0];
        await dbRun(`UPDATE user_remember SET ${field} = NULL WHERE user_id = ?`, [interaction.user.id]);
        await interaction.update({ content: `Removed your ${field} from remembered info.`, components: [] });
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
              .setDisabled(totalPages <= 1)
          );
          await interaction.update({ content, components: [buttons] });
        } catch (error) {
          advancedErrorHandler(error, "Database Folder Selection");
          await interaction.reply({ content: "An error occurred while retrieving folder data.", ephemeral: true });
        }
      }
    } else if (interaction.isButton()) {
      const customId = interaction.customId;
      if (customId.startsWith("log_page_prev_") || customId.startsWith("log_page_next_")) {
        try {
          const parts = customId.split("_");
          const direction = parts[2]; // "prev" or "next"
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
      } else if (customId.startsWith("listusers_prev_") || customId.startsWith("listusers_next_")) {
        try {
          const parts = customId.split("_");
          const direction = parts[1]; // "prev" or "next"
          let currentPage = parseInt(parts[2], 10);
          const users = await dbQuery("SELECT username, user_id FROM user_data");
          const pageSize = 10;
          const totalPages = Math.ceil(users.length / pageSize);
          if (customId.startsWith("listusers_next_")) {
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
      } else if (customId.startsWith("getstats_all_")) {
        try {
          const parts = customId.split("_");
          let currentPage = parseInt(parts[2], 10);
          const guilds = Array.from(client.guilds.cache.values());
          const pageSize = 5;
          const totalPages = Math.ceil(guilds.length / pageSize);
          const start = (currentPage - 1) * pageSize;
          const pageGuilds = guilds.slice(start, start + pageSize);
          let content = `**Servers (Page ${currentPage} of ${totalPages}):**\n`;
          pageGuilds.forEach((guild, index) => {
            content += `${start + index + 1}. ${guild.name} (${guild.id})\n`;
          });
          const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`getstats_all_prev_${currentPage}`)
              .setLabel("Previous")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(currentPage === 1),
            new ButtonBuilder()
              .setCustomId(`getstats_all_next_${currentPage}`)
              .setLabel("Next")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(currentPage === totalPages)
          );
          await interaction.update({ content, components: [buttons] });
        } catch (error) {
          advancedErrorHandler(error, "GetStats All Servers Pagination");
          await interaction.reply({ content: "An error occurred while updating servers list.", ephemeral: true });
        }
      } else if (customId.startsWith("getstats_all_prev_") || customId.startsWith("getstats_all_next_")) {
        try {
          const parts = customId.split("_");
          let currentPage = parseInt(parts[3], 10);
          const direction = parts[2];
          const guilds = Array.from(client.guilds.cache.values());
          const pageSize = 5;
          const totalPages = Math.ceil(guilds.length / pageSize);
          if (direction === "prev") {
            currentPage = Math.max(currentPage - 1, 1);
          } else if (direction === "next") {
            currentPage = Math.min(currentPage + 1, totalPages);
          }
          const start = (currentPage - 1) * pageSize;
          const pageGuilds = guilds.slice(start, start + pageSize);
          let content = `**Servers (Page ${currentPage} of ${totalPages}):**\n`;
          pageGuilds.forEach((guild, index) => {
            content += `${start + index + 1}. ${guild.name} (${guild.id})\n`;
          });
          const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`getstats_all_prev_${currentPage}`)
              .setLabel("Previous")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(currentPage === 1),
            new ButtonBuilder()
              .setCustomId(`getstats_all_next_${currentPage}`)
              .setLabel("Next")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(currentPage === totalPages)
          );
          await interaction.update({ content, components: [buttons] });
        } catch (error) {
          advancedErrorHandler(error, "GetStats All Servers Pagination");
          await interaction.reply({ content: "An error occurred while updating servers list.", ephemeral: true });
        }
      } else if (customId === "getstats_select") {
        try {
          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId("getstats_select_menu")
            .setPlaceholder("Select a server")
            .addOptions(Array.from(client.guilds.cache.values()).map(guild => ({
              label: guild.name.length > 25 ? guild.name.substring(0,22) + "..." : guild.name,
              value: guild.id
            })));
          const row = new ActionRowBuilder().addComponents(selectMenu);
          await interaction.update({ content: "Select a server to view its stats:", components: [row] });
        } catch (error) {
          advancedErrorHandler(error, "GetStats Select Server");
          await interaction.reply({ content: "An error occurred while preparing server selection.", ephemeral: true });
        }
      } else if (interaction.isStringSelectMenu() && interaction.customId === "getstats_select_menu") {
        try {
          const serverId = interaction.values[0];
          const guild = client.guilds.cache.get(serverId);
          if (!guild) {
            await interaction.update({ content: "Server not found.", components: [] });
            return;
          }
          const profilePic = guild.iconURL() || "No profile picture.";
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
      } else if (customId.startsWith("database_prev_") || customId.startsWith("database_next_")) {
        try {
          const parts = customId.split("_"); // Format: database_{prev|next}_{folder}_{serverId}_{page}
          const actionType = parts[1];
          const folder = parts[2];
          const serverId = parts[3];
          let currentPage = parseInt(parts[4], 10);
          const pageSize = 25;
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
          const totalPages = Math.ceil(rows.length / pageSize);
          if (actionType === "prev") {
            currentPage = Math.max(currentPage - 1, 1);
          } else if (actionType === "next") {
            currentPage = Math.min(currentPage + 1, totalPages);
          }
          const start = (currentPage - 1) * pageSize;
          const pageRows = rows.slice(start, start + pageSize);
          let content = `**Data from ${folder} (Page ${currentPage} of ${totalPages}):**\n`;
          pageRows.forEach((row, index) => {
            content += `${start + index + 1}. ${JSON.stringify(row)}\n`;
          });
          const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`database_prev_${folder}_${serverId}_${currentPage}`)
              .setLabel("Previous")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(currentPage === 1),
            new ButtonBuilder()
              .setCustomId(`database_next_${folder}_${serverId}_${currentPage}`)
              .setLabel("Next")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(currentPage === totalPages)
          );
          await interaction.update({ content, components: [buttons] });
        } catch (error) {
          advancedErrorHandler(error, "Database Pagination");
          await interaction.reply({ content: "An error occurred while updating folder data.", ephemeral: true });
        }
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
 * SECTION 14: MESSAGE HANDLER
 ********************************************************************/
client.on("messageCreate", async (message) => {
  try {
    if (message.guild && message.channel.type === ChannelType.GuildText) {
      lastActiveChannel.set(message.guild.id, message.channel);
    }
    if (!globalChatEnabled) return;
    await dbRun("INSERT INTO chat_messages (discord_id, channel_id, user, content) VALUES (?, ?, ?, ?)", [message.id, message.channel.id, message.author.id, message.content]);
    if (message.author.id === client.user.id) return;
    if (message.guild) {
      const settings = await getGuildSettings(message.guild.id);
      if (settings.chat_enabled !== 1) return;
      if (settings.allowed_channels.length > 0 && !settings.allowed_channels.includes(message.channel.id)) return;
    }
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
 * SECTION 15: READY EVENT & ROLE ASSIGNMENT
 ********************************************************************/
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
 * SECTION 16: EXPRESS SERVER FOR UPTIME MONITORING
 ********************************************************************/
const app = express();
app.get("/", (req, res) => res.send("noobhay tripathi is alive! 🚀"));
app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));

/********************************************************************
 * SECTION 17: AUTO-RETRY LOGIN FUNCTIONALITY
 ********************************************************************/
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
