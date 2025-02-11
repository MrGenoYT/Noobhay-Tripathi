import { Client, GatewayIntentBits, Partials } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";
import sqlite3 from "sqlite3";
import dotenv from "dotenv";
import express from "express";

dotenv.config();
const { DISCORD_TOKEN, DISCORD_CLIENT_ID, GEMINI_API_KEY, TENOR_API_KEY, PORT } = process.env;

// -------------------------
// Database Setup & Helpers
// -------------------------
const db = new sqlite3.Database("chat.db", sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) console.error("❌ Database Connection Error:", err);
  else console.log("✅ Connected to SQLite Database.");
});

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

// Create tables for chat history, user data, and mood
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, 
    user TEXT, 
    content TEXT, 
    timestamp TEXT DEFAULT (datetime('now', 'localtime'))
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
// Gemini AI Setup & Instructions
// -------------------------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Bot personality instructions updated as requested
const botInstructions = `
you are noobhay tripathi, a 14-year-old human who loves playing roblox and lives in india.
you're a bit overweight and insecure but don’t give a flying shit.
speak in lowercase using gen z slang; keep responses short (15-35 words), natural, and not too cringe.
mix in occasional emojis (especially skulls) and use phrases like:
"zigga open your eyes are you fockinh dumb", "you dumbahh", "bro you know you should kys",
"hell nawh kys zigga", "yeah man idc about ts tbh 💀🙏", "stop yapping bitch ahh", "bruv ;-;", "i’ll touch you", "aight ima dip now", "get ou"
ask questions sometimes and learn from the convo.
`;

// -------------------------
// Discord Client Setup
// -------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

const botName = "noobhay tripathi";
let chatting = false;
let lastReply = "";
const botMessageIds = new Set();

// Conversation tracking per channel
const conversationTracker = new Map();

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
// Meme & GIF Functions with Better Error Handling
// -------------------------
async function getRandomMeme() {
  try {
    const response = await fetch("https://www.reddit.com/r/memes/random.json", {
      headers: { "User-Agent": "noobhay-tripathi-bot/1.0" }
    });
    if (!response.ok) throw new Error(`Reddit API error: ${response.status} ${response.statusText}`);
    const data = await response.json();
    return data[0]?.data?.children[0]?.data?.url || "couldn't fetch a meme, bruh";
  } catch (error) {
    console.error("❌ Meme Fetch Error:", error);
    return "couldn't fetch a meme, bruh";
  }
}

async function getRandomGif(keyword) {
  try {
    // Using Tenor v1 endpoint for reliability
    const response = await fetch(`https://g.tenor.com/v1/search?key=${TENOR_API_KEY}&q=${encodeURIComponent(keyword)}&limit=1`);
    if (!response.ok) throw new Error(`Tenor API error: ${response.status} ${response.statusText}`);
    const data = await response.json();
    if (data.results && data.results.length > 0 && data.results[0].media && data.results[0].media[0]?.gif?.url) {
      return data.results[0].media[0].gif.url;
    }
    throw new Error("No GIF results found");
  } catch (error) {
    console.error("❌ GIF Fetch Error:", error);
    return "couldn't fetch a gif, bruh";
  }
}

// -------------------------
// Gemini Chat Function with Year-Long Memory & History Search
// -------------------------
async function chatWithGemini(userId, userMessage) {
  try {
    // Retrieve the last 25 messages from the past year (ordered from oldest to newest)
    const recentRows = await dbQuery(
      "SELECT content FROM chat_messages WHERE timestamp >= datetime('now', '-365 days') ORDER BY id DESC LIMIT 25"
    );
    const recentChat = recentRows.reverse().map(r => r.content).join("\n");

    // Search the entire year's history for a message that contains the whole line (if any)
    const similarRows = await dbQuery(
      "SELECT content FROM chat_messages WHERE timestamp >= datetime('now', '-365 days') AND content LIKE ? LIMIT 1",
      [`%${userMessage}%`]
    );
    let similarContext = "";
    if (similarRows.length > 0) {
      similarContext = `\npreviously someone said: "${similarRows[0].content}"`;
    }

    // Build the prompt with all context
    const prompt = `${botInstructions}
recent conversation (last 25 msgs):
${recentChat}
new message from user: ${userMessage}${similarContext}
reply (keep it natural with gen z slang, 15-35 words max, ask a question sometimes):`;

    const result = await model.generateContent(prompt);
    let reply = result.response.text() || "uhhh my brain lagged 💀";

    // Enforce word count limits: max 35 words (if over, trim to 35 words)
    const words = reply.trim().split(/\s+/);
    if (words.length > 35) reply = words.slice(0, 35).join(" ");
    // Optionally, if too short (<15 words) you can leave it or add a filler—but here we leave it as is

    // Save user message (even if skipped messages are stored separately, we store all here)
    await dbRun("INSERT INTO chat_messages (user, content) VALUES (?, ?)", [userId, userMessage]);
    // Update user behavior data
    await dbRun(
      "INSERT OR IGNORE INTO user_data (user_id, behavior) VALUES (?, ?)",
      [userId, '{"interactions":0}']
    );
    await dbRun(
      "UPDATE user_data SET behavior = json_set(behavior, '$.interactions', (json_extract(behavior, '$.interactions') + 1)) WHERE user_id = ?",
      [userId]
    );
    return reply;
  } catch (error) {
    console.error("❌ Gemini API Error:", error);
    return "yo my brain glitched, try again 💀";
  }
}

// -------------------------
// Conversation & Skip Logic Functions
// -------------------------
function shouldReply(message) {
  // If message is a reply to one of the bot's messages, 90% chance to respond.
  if (message.reference?.messageId && botMessageIds.has(message.reference.messageId)) {
    return Math.random() < 0.90;
  }
  
  const lower = message.content.toLowerCase();
  // If message mentions bot name, 95% chance.
  if (lower.includes(botName)) return Math.random() < 0.95;
  
  // If greeting is detected ("yo", "hey", "hi", "hello", "noobhay"), 60% chance.
  const greetings = ["yo", "hey", "hi", "hello", "noobhay"];
  if (greetings.some(g => lower.startsWith(g) || lower.includes(` ${g} `))) return Math.random() < 0.60;
  
  // Conversation tracking: store and count all messages even if skipped.
  const channelId = message.channel.id;
  if (!conversationTracker.has(channelId)) conversationTracker.set(channelId, { count: 0, participants: new Set() });
  const tracker = conversationTracker.get(channelId);
  tracker.count++;
  tracker.participants.add(message.author.id);
  const skipThreshold = tracker.participants.size > 1 ? 2 : 1;
  if (tracker.count < skipThreshold) return false;
  // For solo conversations, use a 20% chance to skip (and 10% for multi-person)
  const chanceNotReply = tracker.participants.size > 1 ? 0.10 : 0.20;
  tracker.count = 0; // reset counter after threshold
  return Math.random() >= chanceNotReply;
}

// -------------------------
// Discord Message Handler
// -------------------------
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    
    // Always store every user message for full conversation history (1-year retention)
    await dbRun("INSERT INTO chat_messages (user, content) VALUES (?, ?)", [message.author.id, message.content]);

    if (!chatting) return; // if bot is not in chatting mode, just log messages

    // 10% chance to send a meme or gif if trigger words are found
    const triggers = ["meme", "funny", "gif"];
    if (triggers.some(t => message.content.toLowerCase().includes(t)) && Math.random() < 0.10) {
      if (Math.random() < 0.5) {
        const meme = await getRandomMeme();
        message.channel.send(meme).catch(err => console.error("Send error:", err));
      } else {
        const gif = await getRandomGif("funny");
        if (gif) message.channel.send(gif).catch(err => console.error("Send error:", err));
      }
      return;
    }

    // Decide if we should reply based on conversation logic
    if (!shouldReply(message)) return;

    const replyContent = await chatWithGemini(message.author.id, message.content);
    if (replyContent === lastReply) return;
    lastReply = replyContent;
    
    const emoji = getRandomEmoji(message);
    const finalReply = `${replyContent} ${emoji}`;
    
    message.channel.send(finalReply)
      .then(sentMsg => {
        botMessageIds.add(sentMsg.id);
        // Remove bot message id after 1 hour
        setTimeout(() => botMessageIds.delete(sentMsg.id), 3600000);
      })
      .catch(err => console.error("Send error:", err));
  } catch (error) {
    console.error("❌ Message Handler Error:", error);
  }
});

// -------------------------
// Slash Commands (/start and /stop)
// -------------------------
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isCommand()) return;
    
    const startReplies = [
      "ayyy i'm awake 💀", "yo wassup 😎", "ready to chat, let's go! 🔥", "oh, finally someone noticed me 😤",
      "let's get this bread 💯", "imma get started now 🔥", "yo, i'm here 👀", "sup, i'm online 💀"
    ];
    const stopReplies = [
      "fine, i'm out 💀", "peace out losers ✌️", "later, nerds 👋", "imma dip now 😤",
      "bye, don't miss me 😏", "i'm ghosting y'all 💀", "adios, suckas ✌️"
    ];
    
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
    console.error("❌ Interaction Error:", error);
  }
});

// -------------------------
// Express Server for Uptime Monitoring
// -------------------------
const app = express();
const port = PORT || 3000;
app.get("/", (req, res) => res.send("noobhay tripathi is alive! 🚀"));
app.listen(port, () => console.log(`✅ web server running on port ${port}`));

// -------------------------
// Global Error Handlers
// -------------------------
process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
});
process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
});

// -------------------------
// Log In the Bot
// -------------------------
client.login(DISCORD_TOKEN).catch(err => console.error("❌ Discord Login Error:", err));
