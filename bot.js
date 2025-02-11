import { Client, GatewayIntentBits, Partials } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";
import sqlite3 from "sqlite3";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// API Keys & Bot Info
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TENOR_API_KEY = process.env.TENOR_API_KEY;

// Database Setup
const db = new sqlite3.Database("chat.db", sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) console.error("❌ Database Connection Error:", err);
  else console.log("✅ Connected to SQLite Database.");
});

// Database Helper Functions
const dbQuery = (query, params = []) => new Promise((resolve, reject) => {
  db.all(query, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});

const dbRun = (query, params = []) => new Promise((resolve, reject) => {
  db.run(query, params, (err) => (err ? reject(err) : resolve()));
});

// Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, content TEXT, timestamp TEXT DEFAULT (datetime('now', 'localtime')));`);
  db.run(`CREATE TABLE IF NOT EXISTS user_data (user_id TEXT PRIMARY KEY, behavior TEXT DEFAULT '{}');`);
  db.run(`CREATE TABLE IF NOT EXISTS mood_data (user_id TEXT PRIMARY KEY, mood TEXT DEFAULT 'neutral');`);
});

// AI Setup
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Client Setup
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

// Bot Variables
const botName = "Noobhay Tripathi";
let chatting = false;
let lastMessageTime = Date.now();
let inactivityMessageSent = false;
let messageCounter = 0;
let messagesBeforeReply = Math.floor(Math.random() * 2) + 2;

// Responses & Memes
const startReplies = ["ayyy i'm awake", "yo wassup 😎", "ready to chat, let's go!", "oh, finally someone noticed me!", "who woke me up??"];
const stopReplies = ["fine, i'm out", "peace out losers ✌️", "guess i'm not wanted huh", "smh, no one loves me fr"];
const spamReplies = ["BRO STOP SPAMMING 💀", "chill dude, i'm already here!", "yo wtf relax lmao"];
const genZSlangs = ["fr", "bet", "cap", "no cap", "sus", "based", "ratio", "mid", "bruh", "skibidi", "gyatt", "lit", "vibe check", "drip", "yeet", "nah fam", "smh", "lowkey", "highkey", "simp", "sigma", "chad", "goofy ahh", "sigma grindset", "no shot", "rip bozo", "nah that's wild", "izz what it iz", "big W", "L moment", "on god", "deadass", "ayo?", "say less", "get gud", "bricked up", "ion even know", "that ain't it chief", "bussin", "sussy baka", "sus af", "valid", "red flag 🚩", "blue flag 🏳️", "bruh moment", "we ballin", "nah this ain't it", "big yikes", "no thoughts head empty", "crying rn", "y'all weird", "speaking facts", "hold this L", "ratio'd"];

// Fetch Meme
async function getRandomMeme() {
  try {
    const response = await fetch("https://www.reddit.com/r/memes/random.json");
    if (!response.ok) throw new Error(`Reddit API Error: ${response.statusText}`);
    const data = await response.json();
    return data[0].data.children[0].data.url;
  } catch (error) {
    console.error("❌ Meme Fetch Error:", error);
    return "Couldn't find a meme, bruh.";
  }
}

// Fetch GIF
async function getRandomGif(keyword) {
  try {
    const response = await fetch(`https://tenor.googleapis.com/v2/search?q=${keyword}&key=${TENOR_API_KEY}&limit=1`);
    if (!response.ok) throw new Error(`Tenor API Error: ${response.statusText}`);
    const data = await response.json();
    return data.results.length ? data.results[0].media[0].gif.url : null;
  } catch (error) {
    console.error("❌ GIF Fetch Error:", error);
    return null;
  }
}

// Chat Function
async function chatWithGemini(userId, userMessage) {
  try {
    const chatHistory = await dbQuery("SELECT content FROM chat_messages WHERE timestamp >= datetime('now', '-3 days') ORDER BY timestamp DESC LIMIT 50");
    const userBehavior = (await dbQuery("SELECT behavior FROM user_data WHERE user_id = ?", [userId]))[0]?.behavior || "{}";

    const result = await model.generateContent(userMessage);
    const reply = result.response.text() || "uhhh my brain lagged 💀";

    await dbRun("INSERT INTO chat_messages (user, content) VALUES (?, ?)", [userId, userMessage]);
    return reply;
  } catch (error) {
    console.error("❌ Gemini API Error:", error);
    return "yo my brain glitched, try again 😭";
  }
}

// Message Handling
client.on("messageCreate", async (message) => {
  if (message.author.bot || !chatting) return;
  lastMessageTime = Date.now();
  inactivityMessageSent = false;

  // Respond if tagged or mentions bot
  if (Math.random() > 0.05 && message.content.toLowerCase().includes(botName.toLowerCase())) {
    return message.reply(await chatWithGemini(message.author.id, message.content));
  }

  // 30% chance to send meme or GIF
  if (Math.random() < 0.30) {
    const memeUrl = await getRandomMeme();
    const gifUrl = await getRandomGif("funny");
    return memeUrl ? message.reply(memeUrl) : gifUrl ? message.reply(gifUrl) : null;
  }

  message.reply(await chatWithGemini(message.author.id, message.content));
});

// Slash Commands
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;
  if (interaction.commandName === "start") {
    if (chatting) return interaction.reply(spamReplies[Math.floor(Math.random() * spamReplies.length)]);
    chatting = true;
    interaction.reply(startReplies[Math.floor(Math.random() * startReplies.length)]);
  } else if (interaction.commandName === "stop") {
    chatting = false;
    interaction.reply(stopReplies[Math.floor(Math.random() * stopReplies.length)]);
  }
});

// Start Express server (Fix for Render)
import express from "express";
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Noobhay Tripathi is alive! 🚀");
});

app.listen(PORT, () => {
  console.log(`✅ Web server running on port ${PORT}`);
});

client.login(DISCORD_TOKEN);
