import { Client, GatewayIntentBits, Partials, Collection } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";
import sqlite3 from "sqlite3";
import dotenv from "dotenv";
import express from "express";
import fs from "fs";

// -------------------------
// Load Environment Variables
// -------------------------
dotenv.config();
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TENOR_API_KEY = process.env.TENOR_API_KEY;

// -------------------------
// Error Logging Function
// -------------------------
function logError(error) {
  console.error(error);
  fs.appendFile(
    "error.log",
    `${new Date().toISOString()} - ${error.toString()}\n`,
    (err) => {
      if (err) console.error("Failed to write error log:", err);
    }
  );
}

// -------------------------
// Database Setup & Helpers
// -------------------------
const db = new sqlite3.Database(
  "chat.db",
  sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
  (err) => {
    if (err) console.error("❌ Database Connection Error:", err);
    else console.log("✅ Connected to SQLite Database.");
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

// Create tables if not exists
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, 
    user TEXT, 
    content TEXT, 
    timestamp TEXT DEFAULT (datetime('now','localtime'))
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS user_data (
    user_id TEXT PRIMARY KEY, 
    behavior TEXT DEFAULT '{"interactions":0}'
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS mood_data (
    user_id TEXT PRIMARY KEY, 
    mood TEXT DEFAULT 'neutral'
  );`);
});

// -------------------------
// Gemini AI Setup & Personality Instructions
// -------------------------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Updated personality prompt:
// - Lives in India, 14 years old, loves roblox
// - Uses gen z slang, concise responses (15-40 words max), less cringe, but asks questions occasionally.
// - Incorporates the user's display name if available.
const botInstructions = `
you are noobhay tripathi, a 14-year-old from india who loves playing roblox.
be chill, a bit insecure but real. use gen z slang, be concise, and keep each reply between 15 and 40 words.
avoid being too cringe; answer like a normal human with a gen z twist.
incorporate the user's name when possible.
ask questions sometimes and reason based on past chats.
`;

// -------------------------
// Discord Client Setup
// -------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});
const botName = "noobhay tripathi";
let chatting = false;
let lastMessageTime = Date.now();
const botMessageIds = new Set();
// Store the last reply to avoid duplicates
let lastReply = "";

// For conversation control: track per-channel conversation state
const conversationTracker = new Map();

// Periodically reset conversation trackers (e.g., every hour)
setInterval(() => {
  conversationTracker.clear();
}, 3600000);

// -------------------------
// Response Arrays for Slash Commands
// -------------------------
const startReplies = [
  "ayyy i'm awake 💀",
  "yo wassup 😎",
  "ready to chat, let's go! 🔥",
  "oh, finally someone noticed me 😤",
];
const stopReplies = [
  "fine, i'm out 💀",
  "peace out ✌️",
  "imma dip now 😤",
  "later, nerds 👋",
];

// -------------------------
// Utility Functions
// -------------------------
function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomEmoji(message) {
  if (message.guild && message.guild.emojis.cache.size > 0) {
    const emojis = Array.from(message.guild.emojis.cache.values());
    return getRandomElement(emojis).toString();
  }
  return getRandomElement(["💀", "😎", "🔥", "🤙", "🙌"]);
}

// -------------------------
// Meme & GIF Fetch Functions
// -------------------------
async function getRandomMeme() {
  try {
    const response = await fetch("https://www.reddit.com/r/memes/random.json", {
      headers: { "User-Agent": "noobhay-tripathi-bot/1.0" },
    });
    if (!response.ok) {
      throw new Error(`Reddit API Error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return data[0].data.children[0].data.url;
  } catch (error) {
    logError(error);
    return "couldn't fetch a meme, bruh";
  }
}

async function getRandomGif(keyword) {
  try {
    const url = `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(
      keyword
    )}&key=${TENOR_API_KEY}&limit=1`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Tenor API Error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (data.results && data.results.length > 0 && data.results[0].media_formats && data.results[0].media_formats.gif) {
      return data.results[0].media_formats.gif.url;
    }
    return "couldn't find a gif, bruh";
  } catch (error) {
    logError(error);
    return "couldn't fetch a gif, bruh";
  }
}

// -------------------------
// Search Chat History for Similar Content
// -------------------------
async function searchChatHistory(query) {
  try {
    // Use the whole query string to search in the last year
    const sql = `
      SELECT content FROM chat_messages 
      WHERE timestamp >= datetime('now', '-1 year') AND content LIKE ? 
      ORDER BY timestamp DESC LIMIT 10
    `;
    const rows = await dbQuery(sql, [`%${query}%`]);
    if (rows && rows.length) {
      // Join all found chats as context
      return rows.map((r) => r.content).join("\n");
    }
    return "";
  } catch (error) {
    logError(error);
    return "";
  }
}

// -------------------------
// Gemini Chat Function
// -------------------------
async function chatWithGemini(userId, displayName, userMessage) {
  try {
    // Get recent conversation context (last 25 messages from 1 year)
    const recentRows = await dbQuery(
      `SELECT content FROM chat_messages 
       WHERE timestamp >= datetime('now', '-1 year') 
       ORDER BY timestamp DESC LIMIT 25`
    );
    const recentChat = recentRows.map((r) => r.content).join("\n");

    // Search for similar past chats using the whole message as query
    const similarChats = await searchChatHistory(userMessage);

    // Build the prompt with all context, including the user's display name
    const prompt = `${botInstructions}
user (${displayName}): ${userMessage}
recent conversation:
${recentChat}
${similarChats ? "previous similar chats:\n" + similarChats : ""}
reply (remember: keep it short between 15 and 40 words, avoid extra cringe, and include a question sometimes):`;

    const result = await model.generateContent(prompt);
    let reply = result.response.text() || "uhhh my brain lagged 💀";

    // Post-process reply: trim each sentence to a max of 35 words and overall max 40 words
    reply = reply
      .split(".")
      .map((sentence) => {
        const words = sentence.trim().split(/\s+/);
        return words.length > 35 ? words.slice(0, 35).join(" ") : sentence.trim();
      })
      .join(". ");
    const allWords = reply.split(/\s+/);
    if (allWords.length > 40) {
      reply = allWords.slice(0, 40).join(" ");
    }

    // Save user message in chat history
    await dbRun("INSERT INTO chat_messages (user, content) VALUES (?, ?)", [userId, userMessage]);
    // Update user behavior data
    await dbRun("INSERT OR IGNORE INTO user_data (user_id, behavior) VALUES (?, ?)", [userId, '{"interactions":0}']);
    await dbRun(
      "UPDATE user_data SET behavior = json_set(behavior, '$.interactions', (json_extract(behavior, '$.interactions') + 1)) WHERE user_id = ?",
      [userId]
    );
    return reply;
  } catch (error) {
    logError(error);
    return "yo my brain glitched, try again 💀";
  }
}

// -------------------------
// Conversation Skip Logic Function
// -------------------------
function shouldReply(message) {
  try {
    // If replying to a bot message, 90% chance to respond.
    if (message.reference?.messageId && botMessageIds.has(message.reference.messageId)) {
      return Math.random() < 0.90;
    }

    const lowerContent = message.content.toLowerCase();
    // If message mentions bot name, 95% chance.
    if (lowerContent.includes(botName)) return Math.random() < 0.95;

    // If greeting detected, 60% chance.
    const greetings = ["yo", "hey", "hi", "hello", "noobhay"];
    if (greetings.some((g) => lowerContent.startsWith(g) || lowerContent.includes(` ${g} `)))
      return Math.random() < 0.60;

    // Conversation tracking: count messages per channel and track participants.
    const channelId = message.channel.id;
    if (!conversationTracker.has(channelId)) {
      conversationTracker.set(channelId, { count: 0, participants: new Set() });
    }
    const tracker = conversationTracker.get(channelId);
    tracker.count++;
    tracker.participants.add(message.author.id);

    // For one-person conversation, set skip chance to 20%; for group chats, 10%.
    const skipThreshold = tracker.participants.size > 1 ? 2 : 1;
    if (tracker.count < skipThreshold) return false;
    const chanceNotReply = tracker.participants.size > 1 ? 0.10 : 0.20;
    tracker.count = 0; // reset after threshold
    return Math.random() >= chanceNotReply;
  } catch (error) {
    logError(error);
    return false;
  }
}

// -------------------------
// Main Message Handler
// -------------------------
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || !chatting) return;
    lastMessageTime = Date.now();

    // 10% chance to send a meme or gif if trigger words are present
    const triggers = ["meme", "funny", "gif"];
    if (triggers.some((t) => message.content.toLowerCase().includes(t)) && Math.random() < 0.10) {
      if (Math.random() < 0.5) {
        const meme = await getRandomMeme();
        message.channel.send(meme).catch(logError);
      } else {
        const gif = await getRandomGif("funny");
        if (gif) message.channel.send(gif).catch(logError);
      }
      return;
    }

    if (!shouldReply(message)) return;

    // Use display name if available, else username
    const displayName = message.member?.displayName || message.author.username;
    const replyContent = await chatWithGemini(message.author.id, displayName, message.content);
    if (replyContent === lastReply) return;
    lastReply = replyContent;

    // Append a random emoji
    const emoji = getRandomEmoji(message);
    const finalReply = `${replyContent} ${emoji}`;

    // Send reply and track message id
    message.channel.send(finalReply).then((sentMsg) => {
      botMessageIds.add(sentMsg.id);
      setTimeout(() => botMessageIds.delete(sentMsg.id), 3600000);
    }).catch(logError);
  } catch (error) {
    logError(error);
  }
});

// -------------------------
// Slash Commands (/start and /stop)
// -------------------------
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isCommand()) return;

    if (interaction.commandName === "start") {
      if (chatting) {
        await interaction.reply(getRandomElement(startReplies) + " " + getRandomEmoji(interaction));
        return;
      }
      chatting = true;
      await interaction.reply(getRandomElement(startReplies) + " " + getRandomEmoji(interaction));
    } else if (interaction.commandName === "stop") {
      chatting = false;
      await interaction.reply(getRandomElement(stopReplies) + " " + getRandomEmoji(interaction));
    }
  } catch (error) {
    logError(error);
    try {
      await interaction.reply("an error occurred, try again later.");
    } catch (e) {
      logError(e);
    }
  }
});

// -------------------------
// Express Server for Uptime Monitoring
// -------------------------
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("noobhay tripathi is alive! 🚀"));
app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));

// -------------------------
// Log In the Bot
// -------------------------
client.login(DISCORD_TOKEN).catch(logError);
