import { Client, GatewayIntentBits, Partials } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";
import sqlite3 from "sqlite3";
import dotenv from "dotenv";
import express from "express";

// ─── LOAD ENV VARIABLES ────────────────────────────────────────────── //
dotenv.config();
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TENOR_API_KEY = process.env.TENOR_API_KEY;

// ─── BOT & GEMINI INSTRUCTIONS ────────────────────────────────────────── //
// IMPORTANT: The following instructions force Gemini to respond like Noobhay Tripathi.
// Noobhay is a 14-year-old human who’s a bit overweight and insecure,
// doesn’t give a flying shit about what others say (but cares about his own opinions),
// loves playing roblox, and created the "colour gang" server (with Red as his closest and Blue as a leader).
// Always respond in lowercase using gen z slang and informal language, with each sentence having at most 50 words.
// Do not tag or mention any user – reply in the channel as general chat.
// Response logic:
//   - 95% chance of replying when directly tagged.
//   - 60% chance of replying when greeted (e.g. "yo", "hey", "noobhay").
//   - When a message is a reply to your own, reply 90% of the time.
//   - Otherwise, wait 2–3 messages before replying (with a 10% chance to skip).
//   - There’s a 10% chance to send a meme or gif (fetched from reddit/tenor) instead of a text reply.
// Do not mention you’re an AI or a search tool; avoid repetition.
// Use custom emojis (especially skull emojis 💀) in replies.
// Occasionally insert one of these lines:
//   "zigga open your eyes are you fockinh dumb", "you dumbahh", "bro you know you should kys",
//   "hell nawh kys zigga", "yeah man idc about ts tbh 💀🙏", "stop yapping bitch ahh",
//   "bruv ;-;", "i’ll touch you", "aight ima dip now", "get ou"
const geminiInstructions = `
you are noobhay tripathi, a 14-year-old human who loves roblox and runs the "colour gang" discord server.
you're a bit overweight and insecure, but you don't give a flying shit about what others say – you care about your own vibe.
your closest homie is red and blue is a respected leader.
respond in lowercase using gen z slang, be concise (max 50 words per sentence) and never tag anyone.
when replying, follow these rules:
  • 95% chance to reply when directly tagged.
  • 60% chance when greeted (yo, hey, noobhay, etc).
  • if someone replies to your message, reply 90% of the time.
  • normally, wait 2-3 messages (with a 10% chance to skip replying).
  • 10% chance to drop a meme or gif (relevant to context).
always analyze recent conversation (last 50 messages from the past 3 days) before answering.
do not say you're an ai or mention search features.
sprinkle in custom emojis (especially 💀) and use phrases like:
"zigga open your eyes are you fockinh dumb", "you dumbahh", "bro you know you should kys", "hell nawh kys zigga", 
"yeah man idc about ts tbh 💀🙏", "stop yapping bitch ahh", "bruv ;-;", "i’ll touch you", "aight ima dip now", "get ou".
`;

// ─── DATABASE SETUP ─────────────────────────────────────────────────── //
const db = new sqlite3.Database("chat.db", sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) console.error("❌ database connection error:", err);
  else console.log("✅ connected to sqlite database.");
});
const dbQuery = (query, params = []) =>
  new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
const dbRun = (query, params = []) =>
  new Promise((resolve, reject) => {
    db.run(query, params, (err) => (err ? reject(err) : resolve()));
  });
db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, content TEXT, timestamp TEXT DEFAULT (datetime('now', 'localtime')));");
  db.run("CREATE TABLE IF NOT EXISTS user_data (user_id TEXT PRIMARY KEY, behavior TEXT DEFAULT '{}');");
  db.run("CREATE TABLE IF NOT EXISTS mood_data (user_id TEXT PRIMARY KEY, mood TEXT DEFAULT 'neutral');");
});

// ─── GEMINI AI SETUP ──────────────────────────────────────────────────── //
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// ─── DISCORD CLIENT SETUP ───────────────────────────────────────────── //
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});
const botName = "noobhay tripathi";
let chatting = false;
let lastMessageTime = Date.now();
let messageCounter = 0;
let messagesBeforeReply = Math.floor(Math.random() * 2) + 2;

// ─── RESPONSE ARRAYS ──────────────────────────────────────────────────── //
const startReplies = [
  "ayyy i'm awake 💀", "yo wassup 😎", "ready to chat, let's go!", "oh, finally someone noticed me", "who woke me up??",
  "let's get this bread 💀", "im here, what's good?", "woke up from my nap, let's vibe", "what's poppin'?", "i'm back in action 💀",
  "sup, let's chat", "time to spill some tea ☕", "i'm lit and ready", "all ears, fam", "let's do this 💀",
  "hey, i'm up", "noobhay's in the house", "i'm here, let's roll", "awake and operational", "ready to drop some truth",
  "yo, i gotchu", "let's get this party started", "back at it", "imma chat now", "noobhay reporting in", "i'm alive 💀", "let's vibe",
  "what's cracking?", "im ready, no cap", "time to chat 💀"
];
const stopReplies = [
  "fine, i'm out 💀", "peace out losers ✌️", "guess i'm not wanted huh", "smh, no one loves me fr", "i'm ghosting now",
  "later, nerds", "i'm dipping 💀", "time to bounce", "im out, stay woke", "catch ya on the flip side",
  "bye bye, suckas", "i'm gone", "see ya, wouldn't wanna be ya", "i'm signing off", "later skater 💀",
  "i'm out like a light", "bye felicia", "i'm done here", "catch you later", "time to dip 💀",
  "imma vanish", "later, gator", "i'm done chatting", "peace, out", "i'm checking out", "bye now", "ghosting 💀", "see ya", "im off", "laterz"
];
const spamReplies = [
  "bro stop spamming 💀", "chill dude, i'm already here", "yo wtf relax lmao", "take it easy, fam", "calm down, no cap"
];
const extraPhrases = [
  "zigga open your eyes are you fockinh dumb",
  "you dumbahh",
  "bro you know you should kys",
  "hell nawh kys zigga",
  "yeah man idc about ts tbh 💀🙏",
  "stop yapping bitch ahh",
  "bruv ;-;",
  "i’ll touch you",
  "aight ima dip now",
  "get ou"
];
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── CHAT FUNCTION (ANALYZE CONTEXT & GET REPLY) ─────────────────────── //
async function chatWithGemini(userId, userMessage) {
  try {
    const chatHistoryRows = await dbQuery(
      "SELECT content FROM chat_messages WHERE timestamp >= datetime('now', '-3 days') ORDER BY id DESC LIMIT 50"
    );
    const chatHistory = chatHistoryRows.map(row => row.content).join("\n");
    const prompt = `${geminiInstructions}
recent conversation:
${chatHistory}
user: ${userMessage}
noobhay:`;
    const result = await model.generateContent(prompt);
    let reply = result.response.text() || "uhhh my brain lagged 💀";
    // enforce max 50 words per sentence (roughly)
    reply = reply
      .split('.')
      .map(sentence => sentence.trim().split(/\s+/).slice(0, 50).join(" "))
      .join(". ");
    await dbRun("INSERT INTO chat_messages (user, content) VALUES (?, ?)", [userId, userMessage]);
    return reply;
  } catch (error) {
    console.error("❌ gemini api error:", error);
    return "yo my brain glitched, try again 😭";
  }
}

// ─── MEME & GIF FETCHING FUNCTIONS ───────────────────────────────────── //
async function getRandomMeme() {
  try {
    const response = await fetch("https://www.reddit.com/r/memes/random.json");
    if (!response.ok) throw new Error(`reddit api error: ${response.statusText}`);
    const data = await response.json();
    return data[0].data.children[0].data.url;
  } catch (error) {
    console.error("❌ meme fetch error:", error);
    return "couldn't find a meme, bruh.";
  }
}
async function getRandomGif(keyword) {
  try {
    const response = await fetch(`https://tenor.googleapis.com/v2/search?q=${keyword}&key=${TENOR_API_KEY}&limit=1`);
    if (!response.ok) throw new Error(`tenor api error: ${response.statusText}`);
    const data = await response.json();
    return data.results.length ? data.results[0].media[0].gif.url : null;
  } catch (error) {
    console.error("❌ gif fetch error:", error);
    return null;
  }
}

// ─── MESSAGE HANDLING & REPLY LOGIC ────────────────────────────────────── //
client.on("messageCreate", async (message) => {
  // ignore dms or other bots
  if (message.author.bot || !chatting) return;
  lastMessageTime = Date.now();
  messageCounter++;

  // Check if message is a reply to one of our messages (simple check via reference)
  const isReplyToBot = message.reference && message.reference.messageId;
  let replyChance = 0;

  // If the message contains our name (tagged) → 95% chance
  if (message.content.toLowerCase().includes(botName)) {
    replyChance = 0.95;
  }
  // If the message starts with a greeting or includes "noobhay" → 60% chance
  else if (/^(yo|hey|hi|hello|sup)/.test(message.content.toLowerCase()) || message.content.toLowerCase().includes("noobhay")) {
    replyChance = 0.60;
  }
  // If replying to our message → 90% chance
  if (isReplyToBot) {
    replyChance = 0.90;
  }
  // Otherwise, only reply if enough messages have passed (simulate 2-3 message skip)
  if (messageCounter < messagesBeforeReply) return;
  // 10% chance to not reply at all
  if (Math.random() < 0.10) {
    messageCounter = 0;
    messagesBeforeReply = Math.floor(Math.random() * 2) + 2;
    return;
  }
  if (Math.random() > replyChance) return;

  // 10% chance to send a meme/gif instead (if not directly tagged)
  if (Math.random() < 0.10 && !message.content.toLowerCase().includes(botName)) {
    if (Math.random() < 0.5) {
      const meme = await getRandomMeme();
      message.channel.send(meme);
      messageCounter = 0;
      messagesBeforeReply = Math.floor(Math.random() * 2) + 2;
      return;
    } else {
      const gif = await getRandomGif("funny");
      if (gif) {
        message.channel.send(gif);
        messageCounter = 0;
        messagesBeforeReply = Math.floor(Math.random() * 2) + 2;
        return;
      }
    }
  }

  // Otherwise, get a text reply from Gemini
  const replyText = await chatWithGemini(message.author.id, message.content);
  let finalReply = replyText;
  // 20% chance to append one of Noobhay’s extra phrases
  if (Math.random() < 0.20) {
    finalReply += " " + pickRandom(extraPhrases);
  }
  // Send reply in the channel (without tagging)
  message.channel.send(finalReply);
  messageCounter = 0;
  messagesBeforeReply = Math.floor(Math.random() * 2) + 2;
});

// ─── SLASH COMMANDS (START/STOP) ─────────────────────────────────────── //
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;
  if (interaction.commandName === "start") {
    if (chatting) {
      await interaction.reply(pickRandom(spamReplies));
      return;
    }
    chatting = true;
    await interaction.reply(pickRandom(startReplies));
  } else if (interaction.commandName === "stop") {
    chatting = false;
    await interaction.reply(pickRandom(stopReplies));
  }
});

// ─── EXPRESS SERVER (FOR UPTIME) ───────────────────────────────────────── //
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => {
  res.send("noobhay tripathi is alive 💀");
});
app.listen(PORT, () => {
  console.log(`✅ web server running on port ${PORT}`);
});

// ─── LOGIN TO DISCORD ────────────────────────────────────────────────── //
client.login(DISCORD_TOKEN);
