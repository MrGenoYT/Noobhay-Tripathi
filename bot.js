/********************************************************************
 * SECTION 1: IMPORTS & ENVIRONMENT SETUP
 ********************************************************************/
import { 
  Client, GatewayIntentBits, Partials, REST, Routes, 
  ActionRowBuilder, StringSelectMenuBuilder, SlashCommandBuilder,
  ChannelType, PermissionsBitField
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

// Global chat toggle for all servers and global mood settings
let globalChatEnabled = true;
let globalMoodEnabled = false;
let globalMood = "neutral";

/********************************************************************
 * SECTION 2: SUPER ADVANCED ERROR HANDLER
 ********************************************************************/
function advancedErrorHandler(error, context = "General") {
  try {
    const timestamp = new Date().toISOString();
    const errorMsg = `[${timestamp}] [${context}] ${error.stack || error}\n`;
    console.error(errorMsg);
    fs.appendFile("error.log", errorMsg, (err) => {
      if (err) console.error("Failed to write to error.log:", err);
    });
  } catch (e) {
    console.error("Error in advancedErrorHandler:", e);
  }
}

process.on("uncaughtException", (error) => {
  advancedErrorHandler(error, "Uncaught Exception");
});
process.on("unhandledRejection", (reason, promise) => {
  advancedErrorHandler(reason, "Unhandled Rejection");
});

/********************************************************************
 * SECTION 3: DATABASE SETUP (INCLUDING DISCORD MESSAGE IDs)
 ********************************************************************/
// Updated chat_messages schema to include guild_id and channel_id for debug queries
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

// Create tables if they don't exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT,
      guild_id TEXT,
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
  // Server settings table: per-guild chat enable state and allowed channels
  db.run(`
    CREATE TABLE IF NOT EXISTS server_settings (
      guild_id TEXT PRIMARY KEY,
      chat_enabled INTEGER DEFAULT 1,
      allowed_channels TEXT DEFAULT '[]'
    );
  `);
  // Global preferences for all users/servers
  db.run(`
    CREATE TABLE IF NOT EXISTS global_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      preference TEXT
    );
  `);
  // User remember table for personal info
  db.run(`
    CREATE TABLE IF NOT EXISTS user_remember (
      user_id TEXT PRIMARY KEY,
      name TEXT,
      birthday TEXT,
      gender TEXT,
      dislikes TEXT,
      likes TEXT
    );
  `);
  // Media library to store info on memes/gifs
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
 * SECTION 4: BOT CONFIGURATION, MOOD & BASE BEHAVIOUR INSTRUCTIONS
 ********************************************************************/
const allowedMoods = [
  "base mood",
  "roasting",
  "neutral",
  "happy",
  "sad",
  "romantic",
  "rizz",
  "villain arc",
  "chill guy"
];

// Updated preset replies for /setmood (except rizz, which stays unchanged)
const moodPresetReplies = {
  "base mood": "staying cool and composed.",
  "roasting": "get ready for some savage burns 🗿.",
  "neutral": "just chill, no drama.",
  "happy": "feeling epic and radiant.",
  "sad": "feeling low but still a boss.",
  "romantic": "love is in the air, vibes on point.",
  "rizz": "dripping with rizz, nobody is safe",
  "villain arc": "embracing the dark side, let's wreak havoc.",
  "chill guy": "laid-back vibes on point."
};

const baseBehaviour = `Base Behaviour:
1. Respond like a human without repetition.
2. Use casual, modern language.
3. Adapt to the user’s tone.
4. Prioritize relevance.
5. Stay respectful unless provoked.
6. Use humor appropriately.
7. Engage naturally.
8. Maintain clarity.
9. Be authentic.
10. Keep it concise.`;

const moodInstructions = {
  "base mood": `1. Maintain a cool, composed tone.
2. Provide clear, factual responses.
3. Avoid slang or over-emotion.
4. Keep it short and precise.`,
  "roasting": `1. Adopt a savage tone.
2. Deliver brutal, witty insults.
3. Use creative harsh language.
4. Roast when provoked.`,
  "neutral": `1. Stay balanced and factual.
2. Keep responses simple and clear.`,
  "happy": `1. Exude epic, radiant positivity.
2. Keep the tone upbeat and inspiring.`,
  "sad": `1. Reflect a low, but strong vibe.
2. Be sincere and introspective.`,
  "romantic": `1. Speak with subtle passion.
2. Use evocative and warm language.`,
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
  "villain arc": `1. Adopt a menacing tone.
2. Use ultra–offensive language and roast everyone and use gen-z words like nigga,fuck,asshole,dumb,nuh uh,idc,etc.
3. Let aggression show.
4. Embrace your dark side.`,
  "chill guy": `1. Keep it laid-back.
2. Use casual language.
3. Stay calm and friendly.`
};

const botBaseInstructions = `
you're haryaksh pratap.
you're 14 years old.
you live in Ahmedabad, Gujrat India.
you're a good person.
you remember past conversations and personal info.
you roast only when provoked.
you use occasional racial slurs if attacked.
you're not repetitive.
you love food and garba.
you use web search when needed.
your favourite games include roblox and minecraft.
you can access the internet.
your roblox name is red.
you're a savage sigma male with sarcasm.
your best friends are butter and ankit.
use these emojis often: 🗿💀🔥.
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
const conversationTracker = new Map(); // Keyed by channel ID
const userContinuousReply = new Map(); // per-user continuous reply setting
let lastBotMessageContent = "";
let lastReply = "";
const botMessageIds = new Set();

function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Preset responses for /start and /stop commands
const startSuccessReplies = [
  "alright, i'm awake 🔥",
  "ready to roll, let's get it!",
  "i'm online and ready to chat.",
  "back in action, let's do this!",
  "here i am, time to chat."
];
const startAlreadyReplies = [
  "i'm already here, dumbahh 💀",
  "what, did you think i wasn't online?",
  "already online, genius.",
  "yo, i'm chillin' here already.",
  "i'm here, no need to start me again."
];
const stopSuccessReplies = [
  "chat halted, enjoy the silence.",
  "i'm off, catch you later.",
  "going offline for now, peace out.",
  "deactivated here 😔",
  "silence achieved – i'm stopped."
];
const stopAlreadyReplies = [
  "i'm already done, no need to stop me twice.",
  "chill, i'm already in sleep mode.",
  "i'm not chatting here, already stopped.",
  "already paused, genius.",
  "stop already in effect, dude."
];

/********************************************************************
 * SECTION 8: FETCH FUNCTIONS FOR MEMES, GIFS, & WEB SEARCH
 ********************************************************************/
async function getRandomMeme(searchKeyword = "funny") {
  try {
    const url = `https://www.reddit.com/r/memes/search.json?q=${encodeURIComponent(searchKeyword)}&restrict_sr=1&sort=hot&limit=50`;
    const response = await fetch(url, { headers: { "User-Agent": "red-bot/1.0" } });
    if (!response.ok) {
      console.error(`Reddit API error: ${response.status} ${response.statusText}`);
      return { url: "couldn't fetch a meme, sorry.", name: "unknown meme" };
    }
    const data = await response.json();
    if (!data.data || !data.data.children || data.data.children.length === 0) {
      console.error("No meme results found.");
      return { url: "couldn't find a meme, sorry.", name: "unknown meme" };
    }
    const posts = data.data.children.filter(child => child.data && child.data.url && !child.data.over_18);
    if (!posts.length) return { url: "couldn't find a meme, sorry.", name: "unknown meme" };
    const memePost = getRandomElement(posts).data;
    return { url: memePost.url, name: memePost.title || "meme" };
  } catch (error) {
    advancedErrorHandler(error, "getRandomMeme");
    return { url: "couldn't fetch a meme, sorry.", name: "unknown meme" };
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

// Store media details in the database
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
  // Use per-user continuous reply if enabled
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
 * SECTION 10: GEMINI CHAT FUNCTION (WITH MOOD, REMEMBERED INFO, WEB SEARCH 
 *              & OLD CONVERSATION CONTEXT)
 ********************************************************************/
async function chatWithGemini(userId, userMessage) {
  try {
    const rows = await dbQuery("SELECT content FROM chat_messages ORDER BY timestamp DESC LIMIT 100");
    const recentChat = rows.reverse().map(r => r.content).join("\n");

    // Fetch old conversation context using keywords
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

    // Retrieve user data and mood info
    const userRows = await dbQuery("SELECT preferences, username, behavior FROM user_data WHERE user_id = ?", [userId]);
    const userPreferences = userRows[0]?.preferences || "[]";
    const username = userRows[0]?.username || "user";

    const moodRows = await dbQuery("SELECT mood FROM mood_data WHERE user_id = ?", [userId]);
    let userMood = moodRows[0]?.mood || "neutral";
    // Use global mood if enabled
    if (globalMoodEnabled) {
      userMood = globalMood;
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
    return "something went wrong, try again.";
  }
}

/********************************************************************
 * SECTION 11: MOOD & PREFERENCE FUNCTIONS
 ********************************************************************/
async function setMood(userId, mood) {
  mood = mood.toLowerCase();
  if (!allowedMoods.includes(mood)) {
    return `Invalid mood. Available moods: ${allowedMoods.join(", ")}`;
  }
  try {
    await dbRun("INSERT OR IGNORE INTO mood_data (user_id, mood) VALUES (?, ?)", [userId, mood]);
    return moodPresetReplies[mood] || `Mood set to ${mood}`;
  } catch (error) {
    advancedErrorHandler(error, "setMood");
    return "Failed to update mood, try again.";
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
    return "Failed to update preferences, try again.";
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
    return { success: false, message: "Failed to remove preference, try again." };
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
      { name: "mood", type: 3, description: "Your mood", required: true, choices: allowedMoods.map(mood => ({ name: mood, value: mood })) }
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
  // New commands for direct meme and gif fetching
  {
    name: "meme",
    description: "Fetch a meme from Reddit",
    options: [
      { name: "keyword", type: 3, description: "Keyword to search for", required: false }
    ]
  },
  {
    name: "gif",
    description: "Fetch a gif from Tenor",
    options: [
      { name: "keyword", type: 3, description: "Keyword to search for", required: false }
    ]
  },
  // Extended debug commands with new actions
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
      {
        type: 3,
        name: "value",
        description: "Additional value or parameter",
        required: false
      }
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
    description: "Store your personal info (name, birthday, gender, dislikes, likes)",
    options: [
      { name: "name", type: 3, description: "Your name", required: false },
      { name: "birthday", type: 3, description: "Your birthday", required: false },
      { name: "gender", type: 3, description: "Your gender", required: false },
      { name: "dislikes", type: 3, description: "Your dislikes", required: false },
      { name: "likes", type: 3, description: "Your likes", required: false }
    ]
  },
  {
    name: "unremember",
    description: "Remove your stored personal info (interactive menu if no options provided)",
    options: [
      { name: "name", type: 3, description: "Remove your name", required: false },
      { name: "birthday", type: 3, description: "Remove your birthday", required: false },
      { name: "gender", type: 3, description: "Remove your gender", required: false },
      { name: "dislikes", type: 3, description: "Remove your dislikes", required: false },
      { name: "likes", type: 3, description: "Remove your likes", required: false }
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
    // If global chat is off, only allow debug commands
    if (!globalChatEnabled && interaction.commandName !== "debug") {
      await interaction.reply({ content: "Global chat is disabled. Only debug commands are allowed.", ephemeral: true });
      return;
    }
    // For guild commands (non-debug) when chat is stopped, show "start red first" message
    if (interaction.guild && interaction.commandName !== "start" && interaction.commandName !== "debug") {
      const settings = await getGuildSettings(interaction.guild.id);
      if (settings.chat_enabled !== 1) {
        await interaction.reply({ content: "start red first", ephemeral: true });
        return;
      }
    }

    if (interaction.isCommand()) {
      const { commandName } = interaction;
      // Ensure server-only commands are used in guilds
      if ((commandName === "start" || commandName === "stop" || commandName === "set") && !interaction.guild) {
        await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
        return;
      }
      if (commandName === "start") {
        const settings = await getGuildSettings(interaction.guild.id);
        if (settings.chat_enabled === 1) {
          await interaction.reply({ content: getRandomElement(startAlreadyReplies), ephemeral: true });
        } else {
          await setGuildChat(interaction.guild.id, true);
          await interaction.reply({ content: getRandomElement(startSuccessReplies), ephemeral: true });
        }
      } else if (commandName === "stop") {
        const settings = await getGuildSettings(interaction.guild.id);
        if (settings.chat_enabled !== 1) {
          await interaction.reply({ content: getRandomElement(stopAlreadyReplies), ephemeral: true });
        } else {
          await setGuildChat(interaction.guild.id, false);
          await interaction.reply({ content: getRandomElement(stopSuccessReplies), ephemeral: true });
        }
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
      } else if (commandName === "meme") {
        const keyword = interaction.options.getString("keyword") || "funny";
        const memeObj = await getRandomMeme(keyword);
        await interaction.reply({ content: memeObj.url });
      } else if (commandName === "gif") {
        const keyword = interaction.options.getString("keyword") || "funny";
        const gifObj = await getRandomGif(keyword);
        await interaction.reply({ content: gifObj.url });
      } else if (commandName === "remember") {
        const fields = ["name", "birthday", "gender", "dislikes", "likes"];
        let updates = {};
        fields.forEach(field => {
          const value = interaction.options.getString(field);
          if (value) updates[field] = value;
        });
        if (Object.keys(updates).length === 0) {
          await interaction.reply({ content: "Please provide at least one field to remember.", ephemeral: true });
          return;
        }
        const existing = await dbQuery("SELECT * FROM user_remember WHERE user_id = ?", [interaction.user.id]);
        if (existing.length === 0) {
          await dbRun("INSERT INTO user_remember (user_id, name, birthday, gender, dislikes, likes) VALUES (?, ?, ?, ?, ?, ?)", [
            interaction.user.id,
            updates.name || null,
            updates.birthday || null,
            updates.gender || null,
            updates.dislikes || null,
            updates.likes || null
          ]);
        } else {
          for (const field in updates) {
            await dbRun(`UPDATE user_remember SET ${field} = ? WHERE user_id = ?`, [updates[field], interaction.user.id]);
          }
        }
        await interaction.reply({ content: "Your personal info has been remembered.", ephemeral: true });
      } else if (commandName === "unremember") {
        // If any field is provided, remove those; otherwise, show interactive menu
        const fields = ["name", "birthday", "gender", "dislikes", "likes"];
        let provided = false;
        for (const field of fields) {
          if (interaction.options.getString(field)) {
            provided = true;
            break;
          }
        }
        if (provided) {
          for (const field of fields) {
            if (interaction.options.getString(field) !== null) {
              await dbRun(`UPDATE user_remember SET ${field} = NULL WHERE user_id = ?`, [interaction.user.id]);
            }
          }
          await interaction.reply({ content: "Specified personal info has been removed.", ephemeral: true });
        } else {
          // Interactive menu: fetch current remembered info and let user select which field to remove
          const row = (await dbQuery("SELECT * FROM user_remember WHERE user_id = ?", [interaction.user.id]))[0];
          if (!row) {
            await interaction.reply({ content: "No personal info stored.", ephemeral: true });
            return;
          }
          let options = [];
          for (const field of fields) {
            if (row[field]) {
              options.push({ label: `${field}: ${row[field]}`, value: field });
            }
          }
          if (options.length === 0) {
            await interaction.reply({ content: "Nothing to remove.", ephemeral: true });
            return;
          }
          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId("unremember_select")
            .setPlaceholder("Select info to remove")
            .addOptions(options);
          const menuRow = new ActionRowBuilder().addComponents(selectMenu);
          await interaction.reply({ content: "Select the info to remove:", components: [menuRow], ephemeral: true });
        }
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
            // Group conversationTracker data by guild
            let guildStats = {};
            for (const [channelId, data] of conversationTracker.entries()) {
              const channel = client.channels.cache.get(channelId);
              if (channel && channel.guild) {
                const guildId = channel.guild.id;
                if (!guildStats[guildId]) {
                  guildStats[guildId] = { name: channel.guild.name, count: 0 };
                }
                guildStats[guildId].count += data.participants.size;
              }
            }
            const statsMsg = Object.entries(guildStats).map(([id, info]) => `${info.name} (${id}): ${info.count} active participants`).join("\n") || "No active conversations.";
            await interaction.reply({ content: `Stats:\n${statsMsg}`, ephemeral: true });
            break;
          }
          case "listusers": {
            const users = await dbQuery("SELECT username, user_id FROM user_data");
            const userList = users.map(r => `${r.username} (${r.user_id})`).join("\n") || "No users found.";
            await interaction.reply({ content: `Users in DB:\n${userList}`, ephemeral: true });
            break;
          }
          case "globalchat_on":
            globalChatEnabled = true;
            await interaction.reply({ content: "Global chat is now ON for all servers.", ephemeral: true });
            break;
          case "globalchat_off":
            globalChatEnabled = false;
            await interaction.reply({ content: "Global chat is now OFF. Only debug commands are allowed.", ephemeral: true });
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
            // If value provided, remove that preference; otherwise, show interactive menu
            const globalPrefs = await dbQuery("SELECT id, preference FROM global_preferences");
            if (value) {
              await dbRun("DELETE FROM global_preferences WHERE preference = ?", [value]);
              await interaction.reply({ content: `Global preference removed: "${value}" (if it existed)`, ephemeral: true });
            } else {
              if (globalPrefs.length === 0) {
                await interaction.reply({ content: "No global preferences set.", ephemeral: true });
                return;
              }
              const options = globalPrefs.map(pref => ({
                label: pref.preference.length > 25 ? pref.preference.substring(0, 22) + "..." : pref.preference,
                value: pref.id.toString()
              }));
              const selectMenu = new StringSelectMenuBuilder()
                .setCustomId("globalprefremove_select")
                .setPlaceholder("Select a global preference to remove")
                .addOptions(options);
              const row = new ActionRowBuilder().addComponents(selectMenu);
              await interaction.reply({ content: "Select a global preference to remove:", components: [row], ephemeral: true });
            }
            break;
          }
          case "log": {
            // Read the error.log file and show the last 10 lines
            fs.readFile("error.log", "utf8", (err, data) => {
              if (err) {
                interaction.reply({ content: "Unable to read log file.", ephemeral: true });
              } else {
                const lines = data.trim().split("\n");
                const lastLines = lines.slice(-10).join("\n");
                interaction.reply({ content: `Last 10 log entries:\n${lastLines}`, ephemeral: true });
              }
            });
            break;
          }
          case "globalannounce": {
            if (!value) {
              await interaction.reply({ content: "Please provide an announcement message.", ephemeral: true });
              return;
            }
            client.guilds.cache.forEach(async (guild) => {
              try {
                // Attempt to send to the system channel first; if not available, pick the first text channel where the bot has SEND_MESSAGES permission.
                let targetChannel = guild.systemChannel;
                if (!targetChannel) {
                  targetChannel = guild.channels.cache.find(ch => ch.type === ChannelType.GuildText && ch.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.SendMessages));
                }
                if (targetChannel) {
                  await targetChannel.send(value);
                }
              } catch (e) {
                advancedErrorHandler(e, `Global Announcement in ${guild.id}`);
              }
            });
            await interaction.reply({ content: "Global announcement sent.", ephemeral: true });
            break;
          }
          case "status": {
            const statusMsg = client.ws ? "Bot is online." : "Bot appears offline.";
            await interaction.reply({ content: statusMsg, ephemeral: true });
            break;
          }
          case "globalmood": {
            if (!value) {
              await interaction.reply({ content: "Please specify 'enable <mood>' or 'disable'.", ephemeral: true });
              return;
            }
            const parts = value.split(" ");
              if (parts[0].toLowerCase() === "disable") {
              globalMoodEnabled = false;
              await interaction.reply({ content: "Global custom mood disabled. Reverting to user-based mood.", ephemeral: true });
            } else if (parts[0].toLowerCase() === "enable") {
              const mood = parts.slice(1).join(" ").toLowerCase();
              if (!allowedMoods.includes(mood)) {
                await interaction.reply({ content: `Invalid mood. Available moods: ${allowedMoods.join(", ")}`, ephemeral: true });
                return;
              }
              globalMoodEnabled = true;
              globalMood = mood;
              await interaction.reply({ content: `Global custom mood enabled: ${mood}`, ephemeral: true });
            } else {
              await interaction.reply({ content: "Invalid parameter. Use 'enable <mood>' or 'disable'.", ephemeral: true });
            }
            break;
          }
          case "database": {
            if (!value) {
              await interaction.reply({ content: "Specify 'folder', 'server:<id>' or 'channel:<id>'", ephemeral: true });
              return;
            }
            if (value.toLowerCase() === "folder") {
              await interaction.reply({ content: "Database file: chat.db", ephemeral: true });
            } else if (value.toLowerCase().startsWith("server:")) {
              const serverId = value.split(":")[1];
              const msgs = await dbQuery("SELECT content, timestamp FROM chat_messages WHERE guild_id = ? ORDER BY timestamp DESC LIMIT 10", [serverId]);
              const msgList = msgs.map(m => `[${m.timestamp}] ${m.content}`).join("\n") || "No messages found.";
              await interaction.reply({ content: `Messages from server ${serverId}:\n${msgList}`, ephemeral: true });
            } else if (value.toLowerCase().startsWith("channel:")) {
              const channelId = value.split(":")[1];
              const msgs = await dbQuery("SELECT content, timestamp FROM chat_messages WHERE channel_id = ? ORDER BY timestamp DESC LIMIT 10", [channelId]);
              const msgList = msgs.map(m => `[${m.timestamp}] ${m.content}`).join("\n") || "No messages found.";
              await interaction.reply({ content: `Messages from channel ${channelId}:\n${msgList}`, ephemeral: true });
            } else {
              await interaction.reply({ content: "Invalid parameter for database action.", ephemeral: true });
            }
            break;
          }
          default:
            await interaction.reply({ content: "Unknown debug command.", ephemeral: true });
            break;
        }
      } else if (commandName === "set") {
        // New server configuration command
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
        const prefId = interaction.values[0];
        await dbRun("DELETE FROM global_preferences WHERE id = ?", [prefId]);
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
        await interaction.update({ content: `Removed your ${field}.`, components: [] });
      }
    }
  } catch (error) {
    advancedErrorHandler(error, "Interaction Handler");
    try {
      if (!interaction.replied) {
        await interaction.reply({ content: "an error occurred, try again later.", ephemeral: true });
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
    // If global chat is disabled, do not process non-debug messages.
    if (!globalChatEnabled) return;

    // Special commands: show info about the last gif/meme if asked
    if (/what(?:'s| is) in the gif/i.test(message.content)) {
      const rows = await dbQuery("SELECT name FROM media_library WHERE type = ? ORDER BY id DESC LIMIT 1", ["gif"]);
      if (rows.length > 0) {
        await message.channel.send(`The gif shows: ${rows[0].name}`);
      } else {
        await message.channel.send("I don't have info on the last gif.");
      }
      return;
    }
    if (/what(?:'s| is) in the meme/i.test(message.content)) {
      const rows = await dbQuery("SELECT name FROM media_library WHERE type = ? ORDER BY id DESC LIMIT 1", ["meme"]);
      if (rows.length > 0) {
        await message.channel.send(`The meme is titled: ${rows[0].name}`);
      } else {
        await message.channel.send("I don't have info on the last meme.");
      }
      return;
    }

    // Save every message with guild_id and channel_id if applicable
    await dbRun("INSERT INTO chat_messages (discord_id, guild_id, channel_id, user, content) VALUES (?, ?, ?, ?, ?)", [
      message.id,
      message.guild ? message.guild.id : null,
      message.guild ? message.channel.id : null,
      message.author.id,
      message.content
    ]);
    
    // Do not process bot's own messages
    if (message.author.id === client.user.id) return;
    
    // For guild messages, check server settings
    if (message.guild) {
      const settings = await getGuildSettings(message.guild.id);
      if (settings.chat_enabled !== 1) return;
      if (settings.allowed_channels.length > 0 && !settings.allowed_channels.includes(message.channel.id)) return;
    }
    
    // Trigger meme/gif sending if keywords are detected (30% chance)
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
    
    // Check if the bot should reply
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
