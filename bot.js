import { Client, GatewayIntentBits, Partials } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";
import sqlite3 from "sqlite3";
import dotenv from "dotenv";
import express from "express";

dotenv.config();
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TENOR_API_KEY = process.env.TENOR_API_KEY;
const PORT = process.env.PORT || 3000;

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

// Create necessary tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT,
    content TEXT,
    skipped INTEGER DEFAULT 0,
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
// Logging Helper
// -------------------------
function logError(err) {
  console.error(`[${new Date().toISOString()}] Error:`, err);
}

// -------------------------
// Utility Functions
// -------------------------
function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Frequently used emoji pool (includes server custom ones if available)
const frequentlyUsedEmojis = ["😎", "😂", "😭", "💀", "😔", "🔥", "🗿", "😈"];

function getRandomEmoji() {
  return getRandomElement(frequentlyUsedEmojis);
}

// -------------------------
// Preset Signatures (always part of Gemini’s persona)
const signatureLines = `
ZIGGA OPEN YOUR EYES ARE YOU FOCKINH DUMB
You dumbahh
nigga
fork you
bro you know you should kys
hell nawh kys zigga
yeah man idc about ts tbh💀🙏
stop yapping bitch ahh
bruv ;-;
I'll touch you
aight Ima dip now
GET OU
`;

// -------------------------
// Preset Responses for /start and /stop Commands
// 30 presets with emoji & 20 without for start; similarly for stop.
// 50 presets for /start spam.
const startPresetsWithEmoji = [
  "ayyy i'm awake 💀",
  "yo, i'm live 😎",
  "ready to roast 🔥",
  "get ready, i'm here 😈",
  "noobhay in session 💀",
  "woke up and ready to roast 😎",
  "time to get savage 🔥",
  "i'm here, bring it on 😈",
  "let's start this chaos 💀",
  "i'm online and lit 😎",
  "awake and aggressive 🔥",
  "roast mode activated 😈",
  "i'm up, no cap 💀",
  "time to spit truth 😎",
  "ready to bring the heat 🔥",
  "i'm here to roast, bruv 😈",
  "time to drop some savage lines 💀",
  "i'm live, prepare yourself 😎",
  "roast session starting now 🔥",
  "i'm up and no-nonsense 😈",
  "i'm awake, let's get brutal 💀",
  "time to light it up 😎",
  "noobhay is here to roast 🔥",
  "let's get this savage party started 😈",
  "i'm live, no jokes 💀",
  "time to serve some truth 😎",
  "roast time, let's go 🔥",
  "i'm online, brace yourself 😈",
  "awake and ready to rip apart 💀",
  "noobhay's live, let's roast 😎"
];

const startPresetsWithoutEmoji = [
  "ayyy i'm awake",
  "yo, i'm live",
  "ready to roast",
  "get ready, i'm here",
  "noobhay in session",
  "woke up and ready to roast",
  "time to get savage",
  "i'm here, bring it on",
  "let's start this chaos",
  "i'm online and lit",
  "awake and aggressive",
  "roast mode activated",
  "i'm up, no cap",
  "time to spit truth",
  "ready to bring the heat",
  "i'm here to roast, bruv",
  "time to drop some savage lines",
  "i'm live, prepare yourself",
  "roast session starting now",
  "i'm up and no-nonsense"
];

const spamStartPresets = [
  "chill, i'm already live 💀",
  "save your energy, i'm here 😎",
  "hey, no need to spam /start 🔥",
  "already awake, bruv 😈",
  "stop yapping, i'm online 💀",
  "i'm not that slow, dude 😎",
  "relax, i got this 🔥",
  "c'mon, i'm already chatting 😈",
  "save it, i'm live 💀",
  "i already said i'm awake 😎",
  "you just woke me up, now back off 🔥",
  "still here, genius 😈",
  "i'm already on, idiot 💀",
  "duh, i'm awake 😎",
  "spamming won't wake me more 🔥",
  "calm down, i'm here 😈",
  "again? i told you i'm live 💀",
  "don't be extra, i'm online 😎",
  "i already told you, i'm awake 🔥",
  "enough already, i'm live 😈",
  "i heard you the first time, stop it 💀",
  "i'm awake, so zip it 😎",
  "stop spamming, moron 🔥",
  "i got it, i'm awake 😈",
  "enough with the /start command 💀",
  "i already said i'm live, idiot 😎",
  "i'm here, now be cool 🔥",
  "spare me the spam, i'm online 😈",
  "i'm awake, so chill out 💀",
  "i already know you're eager, now relax 😎",
  "i'm live, no need to repeat 🔥",
  "keep it down, i'm here 😈",
  "i already said i'm awake, mate 💀",
  "don't be repetitive, i'm live 😎",
  "i heard you, now quiet 🔥",
  "i'm online, enough already 😈",
  "stop, i'm awake 💀",
  "i got the message, now stop 😎",
  "save your words, i'm live 🔥",
  "repeat after me: i'm awake, now stop 😈",
  "calm it, i'm already on 💀",
  "i already told you, now shut up 😎",
  "i'm live, so ease up 🔥",
  "i'm not sleeping, so stop it 😈",
  "no need for repetition, i'm here 💀",
  "that's enough, i'm awake 😎",
  "spamming won't change a thing 🔥",
  "i'm online, now quit it 😈"
];

const stopPresetsWithEmoji = [
  "fine, i'm out 💀",
  "peace out, losers 😎",
  "guess i'm not wanted 😈",
  "later, nerds 🔥",
  "imma dip now 💀",
  "bye, don't miss me 😎",
  "i'm ghosting y'all 😈",
  "cya, suckas 🔥",
  "i'm out, catch you later 💀",
  "adios, bruv 😎",
  "i'm bouncing now 😈",
  "later, losers 🔥",
  "i'm off, peace 💀",
  "deuces, fam 😎",
  "i'm logging off, bye 😈",
  "catch you on the flip side 🔥",
  "i'm done, see ya 💀",
  "time to dip, bye 😎",
  "i'm ghost, peace out 😈",
  "bye, i'm out 🔥",
  "i'm leaving, don't wait up 💀",
  "later gators 😎",
  "i'm out, peace and love 😈",
  "cya, have fun 🔥",
  "i'm off, take care 💀",
  "later, fam 😎",
  "i'm checking out, bye 😈",
  "i'm ghosting, later 🔥",
  "i'm signing off, bye 💀",
  "cya, no cap 😎"
];

const stopPresetsWithoutEmoji = [
  "fine, i'm out",
  "peace out, losers",
  "guess i'm not wanted",
  "later, nerds",
  "imma dip now",
  "bye, don't miss me",
  "i'm ghosting y'all",
  "cya, suckas",
  "i'm out, catch you later",
  "adios, bruv",
  "i'm bouncing now",
  "later, losers",
  "i'm off, peace",
  "deuces, fam",
  "i'm logging off, bye",
  "catch you on the flip side",
  "i'm done, see ya",
  "time to dip, bye",
  "i'm ghost, peace out",
  "bye, i'm out"
];

// -------------------------
// Mood Management
// -------------------------
const availableMoods = ["roasting", "neutral", "happy", "sad", "romantic", "rizz", "villain arc", "chill guy"];
let currentMood = "neutral";

// Tone instructions based on mood for Gemini prompt.
function getToneForMood(mood) {
  switch (mood) {
    case "roasting":
      return "Respond offensively with savage, insulting, and roasting language using gen z slang.";
    case "villain arc":
      return "Be extremely offensive, ruthless, and villainous with no chill and plenty of insults.";
    case "happy":
      return "Keep the tone upbeat, positive, and full of good vibes.";
    case "sad":
      return "Use a melancholic, somber, and reflective tone.";
    case "romantic":
      return "Be charming, smooth, and romantic.";
    case "rizz":
      return "Adopt a suave, charismatic, and effortlessly cool tone.";
    case "chill guy":
      return "Respond in a laid-back, relaxed, and receptive manner without being offensive.";
    case "neutral":
    default:
      return "Respond in a neutral tone, clear and to the point.";
  }
}

// Preset responses for /mood command confirmation (10 for each mood)
const moodChangePresets = {
  "roasting": [
    "k, mood changed to roasting 🔥",
    "roasting mode activated, bruv 💀",
    "you asked, now i'm roasting 😈",
    "alright, switching to roasting, idiot 😎",
    "roasting it is, no cap 🔥",
    "i'm now in roasting mode, genius 💀",
    "roasting mode on, let's go 😈",
    "i'm set to roast, buckle up 😎",
    "roasting activated, bring it on 🔥",
    "mood changed to roasting, get ready 💀"
  ],
  "neutral": [
    "k, mood changed to neutral.",
    "neutral mode activated, chillin'.",
    "i'm now neutral, listening up.",
    "mood set to neutral, all good.",
    "neutral it is, no drama.",
    "i'm in neutral mode, let's chat.",
    "mood changed to neutral, calm and clear.",
    "neutral activated, bring it on.",
    "i'm set to neutral mode, alright.",
    "mood changed to neutral, staying cool."
  ],
  "happy": [
    "k, mood changed to happy 😊",
    "happy mode activated, let's smile!",
    "i'm now happy, all smiles here!",
    "mood set to happy, enjoy the vibes!",
    "happy it is, feel the joy!",
    "i'm in happy mode, cheers!",
    "mood changed to happy, let's celebrate!",
    "happy mode on, good times ahead!",
    "i'm set to happy, keep smiling!",
    "mood changed to happy, spread the love!"
  ],
  "sad": [
    "k, mood changed to sad 😢",
    "sad mode activated, feeling low.",
    "i'm now sad, it's a bummer.",
    "mood set to sad, life is rough.",
    "sad it is, tears incoming.",
    "i'm in sad mode, not feeling it.",
    "mood changed to sad, gloom mode on.",
    "sad mode on, brace yourself.",
    "i'm set to sad, things are heavy.",
    "mood changed to sad, it's a downer."
  ],
  "romantic": [
    "k, mood changed to romantic ❤️",
    "romantic mode activated, feel the love.",
    "i'm now in a romantic mood, smooth vibes.",
    "mood set to romantic, let's get cozy.",
    "romantic it is, hearts and flowers.",
    "i'm in romantic mode, ready for love.",
    "mood changed to romantic, candlelight time.",
    "romantic mode on, whispers and smiles.",
    "i'm set to romantic, let's vibe love.",
    "mood changed to romantic, love is in the air."
  ],
  "rizz": [
    "k, mood changed to rizz 😏",
    "rizz mode activated, smooth operator.",
    "i'm now in rizz mode, all suave.",
    "mood set to rizz, get your charm on.",
    "rizz it is, let the smooth talk begin.",
    "i'm in rizz mode, slick vibes only.",
    "mood changed to rizz, feel the charisma.",
    "rizz mode on, let's charm 'em.",
    "i'm set to rizz, smooth as ever.",
    "mood changed to rizz, the charm is real."
  ],
  "villain arc": [
    "k, mood changed to villain arc 😈",
    "villain arc activated, prepare for darkness.",
    "i'm now in villain arc mode, no mercy.",
    "mood set to villain arc, evil unleashed.",
    "villain arc it is, chaos reigns.",
    "i'm in villain arc mode, fear me.",
    "mood changed to villain arc, darkness descends.",
    "villain arc on, bring the terror.",
    "i'm set to villain arc, evil is here.",
    "mood changed to villain arc, welcome to darkness."
  ],
  "chill guy": [
    "k, mood changed to chill guy 😎",
    "chill mode activated, just relax.",
    "i'm now in chill mode, all cool vibes.",
    "mood set to chill guy, let's take it easy.",
    "chill it is, calm and collected.",
    "i'm in chill mode, no stress here.",
    "mood changed to chill guy, just chillin'.",
    "chill mode on, easy does it.",
    "i'm set to chill guy, keep it smooth.",
    "mood changed to chill guy, relax and vibe."
  ]
};

// -------------------------
// Gemini AI Setup & Base Instructions
// -------------------------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Base personality instructions including background details.
const baseInstructions = `
You are noobhay tripathi, a 14-year-old human living in India who loves playing roblox.
You're a normal guy—slightly overweight and insecure—but you don't give a flying shit about what others say,
though you do care about what you think. You sometimes wonder if your crush will ever talk to you or if you can even approach her.
You are the creator of Colour Gang, an online Discord server.
Your closest crew includes Red (your ride-or-die), Ankit (your most trustworthy friend and a great guy), and Blue (a chill leader figure who isn't very active).
${signatureLines}
`;

// -------------------------
// Chat with Gemini (Enhanced Context, Mood, and Error Handling)
// -------------------------
async function chatWithGemini(userId, userMessage) {
  try {
    // Retrieve up to 25 recent messages from the past year.
    const recentChatRows = await dbQuery(
      `SELECT content FROM chat_messages 
       WHERE timestamp >= datetime('now', '-1 year') 
       ORDER BY timestamp DESC LIMIT 25`
    );
    const recentChat = recentChatRows.map(r => r.content).join("\n");

    // Retrieve similar past messages based on the user's input.
    const likeQuery = `%${userMessage}%`;
    const similarRows = await dbQuery(
      `SELECT content FROM chat_messages 
       WHERE timestamp >= datetime('now', '-1 year') AND content LIKE ? 
       ORDER BY timestamp DESC LIMIT 25`,
      [likeQuery]
    );
    const similarChat = similarRows.map(r => r.content).join("\n");

    const toneInstruction = getToneForMood(currentMood);
    // Compose the prompt including background, mood, tone, signature lines, and conversation history.
    const prompt = `${baseInstructions}
Tone Instruction: ${toneInstruction}
Current Mood: ${currentMood}
Recent conversation (up to 25 messages from the past year):
${recentChat}
Similar past messages (if relevant):
${similarChat}
User: ${userMessage}
Reply (keep it concise between 15 to 35 words in 1-2 sentences, use gen z slang like "fr", "tbh", "idk", "nuh", "nvm", "cya", and occasionally ask a question):`;

    const result = await model.generateContent(prompt);
    let reply = result.response.text() || "uhhh my brain glitched 💀";

    // Limit each sentence to a maximum of 40 words and overall to 35 words if needed.
    let sentences = reply.split(/[.!?]+/).filter(sentence => sentence.trim().length > 0);
    sentences = sentences.map(sentence => {
      const words = sentence.trim().split(/\s+/);
      return words.length > 40 ? words.slice(0, 40).join(" ") : sentence.trim();
    });
    reply = sentences.join(". ") + ".";
    const totalWords = reply.split(/\s+/);
    if (totalWords.length > 35) {
      reply = totalWords.slice(0, 35).join(" ") + ".";
    }
    
    // Save the user's message for future context.
    await dbRun("INSERT INTO chat_messages (user, content, skipped) VALUES (?, ?, ?)", [userId, userMessage, 0]);
    await dbRun("INSERT OR IGNORE INTO user_data (user_id, behavior) VALUES (?, ?)", [userId, '{"interactions":0}']);
    await dbRun("UPDATE user_data SET behavior = json_set(behavior, '$.interactions', (json_extract(behavior, '$.interactions') + 1)) WHERE user_id = ?", [userId]);
    
    return reply;
  } catch (error) {
    logError(error);
    return "yo my brain glitched, try again 💀";
  }
}

// -------------------------
// Conversation Tracker & Skip Logic
// -------------------------
// Tracks conversation per channel to decide when to reply.
const conversationTracker = new Map();

function shouldReply(message) {
  const channelId = message.channel.id;
  if (!conversationTracker.has(channelId)) {
    conversationTracker.set(channelId, { count: 0, participants: new Set(), skipped: [] });
  }
  const tracker = conversationTracker.get(channelId);
  tracker.count++;
  tracker.participants.add(message.author.id);

  // For solo chats, skip threshold = 1; for group chats, randomly require 1 or 2 messages.
  let skipThreshold = (tracker.participants.size > 1) ? (Math.floor(Math.random() * 2) + 1) : 1;
  if (tracker.count < skipThreshold) {
    tracker.skipped.push(message.content);
    return false;
  }
  tracker.count = 0; // reset after threshold is reached
  // 80% chance to reply.
  return Math.random() >= 0.20;
}

// -------------------------
// Discord Client Setup
// -------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

let chatting = false;
let lastReply = "";
let lastStartCommandTime = 0;
const START_SPAM_INTERVAL = 30000; // 30 seconds

// -------------------------
// Slash Command Interaction Handler (/start, /stop, /mood)
// -------------------------
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isCommand()) return;
    const cmd = interaction.commandName;
    const now = Date.now();

    if (cmd === "start") {
      // If already chatting and /start is invoked again within 30 seconds, use spam presets.
      if (chatting && (now - lastStartCommandTime < START_SPAM_INTERVAL)) {
        await interaction.reply(getRandomElement(spamStartPresets) + " " + getRandomEmoji());
        lastStartCommandTime = now;
        return;
      }
      // Otherwise, if not chatting, start the session.
      chatting = true;
      lastStartCommandTime = now;
      // Randomly choose between preset with or without emoji.
      const preset = (Math.random() < 0.5)
        ? getRandomElement(startPresetsWithEmoji)
        : getRandomElement(startPresetsWithoutEmoji);
      await interaction.reply(preset);
    } else if (cmd === "stop") {
      chatting = false;
      const preset = (Math.random() < 0.5)
        ? getRandomElement(stopPresetsWithEmoji)
        : getRandomElement(stopPresetsWithoutEmoji);
      await interaction.reply(preset);
    } else if (cmd === "mood") {
      const chosenMood = interaction.options.getString("type")?.toLowerCase();
      if (!chosenMood || !availableMoods.includes(chosenMood)) {
        await interaction.reply("Available moods: " + availableMoods.join(", "));
        return;
      }
      currentMood = chosenMood;
      const moodResponse = getRandomElement(moodChangePresets[chosenMood]);
      await interaction.reply(moodResponse, { ephemeral: true });
    }
  } catch (error) {
    logError(error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp("an error occurred 😤");
      } else {
        await interaction.reply("an error occurred 😤");
      }
    } catch (err) {
      logError(err);
    }
  }
});

// -------------------------
// Message Handler
// -------------------------
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    // Save every incoming message for context.
    await dbRun("INSERT INTO chat_messages (user, content, skipped) VALUES (?, ?, ?)", [message.author.id, message.content, 0]);

    if (!chatting) return;

    // 10% chance: if message contains trigger words ("meme", "funny", "gif"), fetch a meme or gif.
    const triggers = ["meme", "funny", "gif"];
    if (triggers.some(t => message.content.toLowerCase().includes(t)) && Math.random() < 0.10) {
      if (Math.random() < 0.5) {
        try {
          const memeResponse = await fetch("https://www.reddit.com/r/memes/random.json", {
            headers: { "User-Agent": "noobhay-tripathi-bot/1.0" }
          });
          if (!memeResponse.ok) throw new Error(`Reddit API Error: ${memeResponse.status}`);
          const memeData = await memeResponse.json();
          const memeUrl = memeData[0]?.data?.children[0]?.data?.url || "couldn't fetch a meme, bruh";
          message.channel.send(memeUrl).catch(err =
