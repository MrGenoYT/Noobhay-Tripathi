// Import necessary modules
import { Client, GatewayIntentBits, Partials, PermissionsBitField } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";
import sqlite3 from "sqlite3";
import dotenv from "dotenv";
import express from "express";

// Load environment variables
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

// Create tables for chat messages, user behavior, and mood data
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

// Frequently used emoji pool – these (and any server custom emojis) will be used
const frequentlyUsedEmojis = ["😎", "😂", "😭", "💀", "😔", "🔥", "🗿", "😈"];
function getRandomEmoji() {
  return getRandomElement(frequentlyUsedEmojis);
}

// -------------------------
// Signature Lines (always included in Gemini’s persona)
const signatureLines = `
ZIGGA OPEN YOUR EYES ARE YOU FOCKINH DUMB
You dumbahh
bro you know you should kys
hell nawh kys zigga
yeah man idc about ts tbh💀🙏
stop yapping bitch ahh
bruv ;-;
I'll touch you
aight Ima dip now
nigga
fork you 
GET OU-
`;

// -------------------------
// Preset Responses for Slash Commands
// Reduced presets for clarity
const startPresetsWithEmoji = [
  "ayyy i'm awake 💀",
  "yo, i'm live 😎",
  "ready to roast 🔥"
];
const startPresetsWithoutEmoji = [
  "ayyy i'm awake",
  "yo, i'm live"
];
const spamStartPresets = [
  "chill, i'm already live 💀",
  "save your energy, i'm here 😎",
  "hey, no need to spam /start 🔥",
  "already awake, bruv 😈",
  "stop yapping, i'm online 💀"
];
const stopPresetsWithEmoji = [
  "fine, i'm out 💀",
  "peace out, losers 😎",
  "imma dip now 🔥"
];
const stopPresetsWithoutEmoji = [
  "fine, i'm out",
  "peace out, losers"
];

// -------------------------
// Mood Management
// -------------------------
const availableMoods = ["roasting", "neutral", "happy", "sad", "romantic", "rizz", "villain arc", "chill guy"];
let currentMood = "neutral"; // Base mood

// Tone instructions per mood
function getToneForMood(mood) {
  switch (mood) {
    case "roasting":
      return "Respond with direct, savage insults using gen z slang. Be offensive but avoid over-cringe language.";
    case "villain arc":
      return "Be extremely offensive and ruthless with cold, merciless insults.";
    case "happy":
      return "Respond in an upbeat, positive, and friendly manner.";
    case "sad":
      return "Respond in a reflective, somber, and empathetic tone.";
    case "romantic":
      return "Be charming, smooth, and romantic in your language.";
    case "rizz":
      return "Respond with suave, charismatic language that’s effortlessly cool.";
    case "chill guy":
      return "Respond politely, calmly, and respectfully while listening to the user.";
    case "neutral":
    default:
      return "Respond in a neutral, clear, and concise tone while attentively listening to the user.";
  }
}

// Mood change confirmations – 3 per mood
const moodChangePresets = {
  "roasting": [
    "k, mood changed to roasting 🔥",
    "roasting mode on, bruv 💀",
    "now roasting – get ready 😈"
  ],
  "neutral": [
    "k, mood changed to neutral.",
    "neutral mode activated.",
    "mood set to neutral, all good."
  ],
  "happy": [
    "k, mood changed to happy 😊",
    "happy mode on, smiles ahead!",
    "now happy – good vibes!"
  ],
  "sad": [
    "k, mood changed to sad 😢",
    "sad mode activated, feeling low.",
    "now sad – it’s a downer."
  ],
  "romantic": [
    "k, mood changed to romantic ❤️",
    "romantic mode on, hearts open.",
    "now romantic – love is in the air."
  ],
  "rizz": [
    "k, mood changed to rizz 😏",
    "rizz mode activated, smooth vibes.",
    "now in rizz mode – charm on!"
  ],
  "villain arc": [
    "k, mood changed to villain arc 😈",
    "villain mode on, no chill.",
    "now villain arc – fear me!"
  ],
  "chill guy": [
    "k, mood changed to chill guy 😎",
    "chill mode on, let's keep it polite.",
    "now chill – I'll be respectful."
  ]
};

// -------------------------
// Base Personality Instructions for Gemini
// -------------------------
const baseInstructions = `
You are noobhay tripathi, a 14-year-old human living in India who loves playing roblox.
You're a normal guy – a bit overweight and insecure – but you don't give a flying shit about what others say,
though you do care about what you think. You often wonder if your crush will ever talk to you or if you can even approach her.
You are the creator of Colour Gang, an online Discord server. Your closest crew includes:
- Red: your ride-or-die, the closest to you.
- butter: your best friend 
- beast: your stupid friend 
- Ankit: your most trustworthy friend.
- Blue: a chill leader figure, not very active.
${signatureLines}
`;

// -------------------------
// Processed Messages Tracker to prevent duplicate replies
// -------------------------
const processedMessageIds = new Set();

// -------------------------
// Conversation Tracker & Skip Logic
// -------------------------
const conversationTracker = new Map();
function shouldReply(message) {
  const channelId = message.channel.id;
  if (!conversationTracker.has(channelId)) {
    conversationTracker.set(channelId, { count: 0, participants: new Set(), skipped: [] });
  }
  const tracker = conversationTracker.get(channelId);
  tracker.count++;
  tracker.participants.add(message.author.id);

  // For solo chats: threshold = 1; for group chats: randomly require 1 or 2 messages.
  let skipThreshold = tracker.participants.size > 1 ? (Math.floor(Math.random() * 2) + 1) : 1;
  if (tracker.count < skipThreshold) {
    tracker.skipped.push(message.content);
    return false;
  }
  tracker.count = 0;
  return Math.random() >= 0.20; // 80% chance to reply
}

// -------------------------
// Chat with Gemini (Context, Mood, and Skipped Messages)
// -------------------------
async function chatWithGemini(userId, userMessage, channelId) {
  try {
    // Retrieve recent context from DB (up to 25 messages from past year)
    const recentRows = await dbQuery(
      `SELECT content FROM chat_messages 
       WHERE timestamp >= datetime('now', '-1 year') 
       ORDER BY timestamp DESC LIMIT 25`
    );
    const recentChat = recentRows.map(r => r.content).join("\n");

    // Retrieve similar past messages based on user input
    const likeQuery = `%${userMessage}%`;
    const similarRows = await dbQuery(
      `SELECT content FROM chat_messages 
       WHERE timestamp >= datetime('now', '-1 year') AND content LIKE ? 
       ORDER BY timestamp DESC LIMIT 25`,
      [likeQuery]
    );
    const similarChat = similarRows.map(r => r.content).join("\n");

    // Retrieve skipped messages from conversation tracker for this channel
    let skippedContext = "";
    if (conversationTracker.has(channelId)) {
      const tracker = conversationTracker.get(channelId);
      if (tracker.skipped.length > 0) {
        skippedContext = tracker.skipped.join("\n");
        tracker.skipped = []; // clear skipped messages after use
      }
    }

    const toneInstruction = getToneForMood(currentMood);

    // Compose the full prompt
    const prompt = `${baseInstructions}
Tone Instruction: ${toneInstruction}
Current Mood: ${currentMood}
Recent conversation (up to 25 messages from the past year):
${recentChat}
Similar past messages (if relevant):
${similarChat}
Skipped messages:
${skippedContext}
User: ${userMessage}
Reply (keep it concise between 15 to 35 words in 1-2 sentences, use gen z slang like "fr", "tbh", "idk", "nvm", "cya", and occasionally ask a question):`;

    const result = await model.generateContent(prompt);
    let reply = result.response.text() || "uhhh my brain glitched 💀";

    // Process reply: limit each sentence to 40 words and overall to ~35 words if needed
    let sentences = reply.split(/[.!?]+/).filter(s => s.trim().length > 0);
    sentences = sentences.map(sentence => {
      const words = sentence.trim().split(/\s+/);
      return words.length > 40 ? words.slice(0, 40).join(" ") : sentence.trim();
    });
    reply = sentences.join(". ") + ".";
    const totalWords = reply.split(/\s+/);
    if (totalWords.length > 35) {
      reply = totalWords.slice(0, 35).join(" ") + ".";
    }

    // Save the user's message for future context
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
      // If already chatting and /start is invoked within 30 seconds, return a spam preset
      if (chatting && (now - lastStartCommandTime < START_SPAM_INTERVAL)) {
        await interaction.reply(getRandomElement(spamStartPresets) + " " + getRandomEmoji());
        lastStartCommandTime = now;
        return;
      }
      chatting = true;
      lastStartCommandTime = now;
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
      // Expecting an option "type" with the mood string
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
    // Prevent duplicate processing for the same message
    if (processedMessageIds.has(message.id)) return;
    processedMessageIds.add(message.id);
    setTimeout(() => processedMessageIds.delete(message.id), 60000);

    if (message.author.bot) return;
    // Save every incoming message for context
    await dbRun("INSERT INTO chat_messages (user, content, skipped) VALUES (?, ?, ?)", [message.author.id, message.content, 0]);

    if (!chatting) return;

    // 10% chance: if message contains trigger words ("meme", "funny", "gif"), fetch and send a meme or gif
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
          message.channel.send(memeUrl).catch(err => logError(err));
        } catch (err) {
          logError(err);
        }
      } else {
        try {
          const url = `https://g.tenor.com/v1/search?q=${encodeURIComponent("funny")}&key=${TENOR_API_KEY}&limit=1`;
          const gifResponse = await fetch(url);
          if (!gifResponse.ok) throw new Error(`Tenor API Error: ${gifResponse.status}`);
          const gifData = await gifResponse.json();
          if (gifData.results && gifData.results.length > 0) {
            const gifUrl = gifData.results[0].media[0]?.gif?.url || "couldn't fetch a gif, bruh";
            message.channel.send(gifUrl).catch(err => logError(err));
          } else {
            logError("No GIF results found.");
          }
        } catch (err) {
          logError(err);
        }
      }
      return;
    }

    // Decide whether to reply based on conversation tracking
    if (!shouldReply(message)) return;

    // Pass channel id for context (including skipped messages)
    const replyContent = await chatWithGemini(message.author.id, message.content, message.channel.id);
    if (replyContent === lastReply) return;
    lastReply = replyContent;

    // Format the reply: append an emoji per sentence with a chance based on mood
    const emojiChance = (currentMood === "roasting" || currentMood === "villain arc") ? 0.66 : 0.33;
    const sentences = replyContent.match(/[^.!?]+[.!?]*/g) || [replyContent];
    const formattedReply = sentences
      .map(sentence => {
        sentence = sentence.trim();
        if (!sentence) return "";
        if (Math.random() < emojiChance) {
          sentence += " " + getRandomEmoji();
        }
        return sentence;
      })
      .filter(s => s.length > 0)
      .slice(0, 5)
      .join(" ");
    
    message.channel.send(formattedReply).catch(err => logError(err));
  } catch (error) {
    logError(error);
  }
});

// -------------------------
// Guild Join Event: Assign "NOOBHAY" Role and Request Necessary Permissions
// -------------------------
client.on("guildCreate", async (guild) => {
  try {
    // Fetch the bot's member object
    const botMember = await guild.members.fetch(client.user.id);
    // Check for a role named "NOOBHAY"; create if missing
    let role = guild.roles.cache.find(r => r.name === "NOOBHAY");
    if (!role) {
      role = await guild.roles.create({
        name: "NOOBHAY",
        color: "RED",
        reason: "Assigning NOOBHAY role to the bot upon joining."
      });
    }
    // Assign the role if not already present
    if (!botMember.roles.cache.has(role.id)) {
      await botMember.roles.add(role);
    }
    console.log(`Assigned NOOBHAY role in guild: ${guild.name}`);
  } catch (error) {
    logError(error);
  }
});

// -------------------------
// Express Server for Uptime Monitoring
// -------------------------
const app = express();
app.get("/", (req, res) => res.send("noobhay tripathi is alive! 🚀"));
app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));

// -------------------------
// Login the Bot
// -------------------------
client.login(DISCORD_TOKEN).catch(err => logError(err));
