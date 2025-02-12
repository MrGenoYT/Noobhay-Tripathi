// ================================
// Imports & Environment Setup
// ================================
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

if (!DISCORD_TOKEN || !GEMINI_API_KEY || !TENOR_API_KEY) {
  console.error("Missing required environment variables. Exiting.");
  process.exit(1);
}

// ================================
// Database Setup & Helpers
// ================================
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

// Create tables for chat messages, user data, and mood data.
db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user TEXT,
      content TEXT,
      skipped INTEGER DEFAULT 0,
      timestamp TEXT DEFAULT (datetime('now', 'localtime'))
    );`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS user_data (
      user_id TEXT PRIMARY KEY,
      behavior TEXT DEFAULT '{"interactions":0}'
    );`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS mood_data (
      user_id TEXT PRIMARY KEY,
      mood TEXT DEFAULT 'neutral'
    );`
  );
});

// ================================
// Logging Helper
// ================================
function logError(err) {
  console.error(`[${new Date().toISOString()}] Error:`, err);
}

// ================================
// Utility Functions & Presets
// ================================
function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomEmoji(message) {
  if (message?.guild && message.guild.emojis.cache.size > 0) {
    const serverEmojis = Array.from(message.guild.emojis.cache.values()).map((e) =>
      e.toString()
    );
    const commonEmojis = ["😎", "😂", "😭", "💀", "😔", "🔥", "🗿", "😈"];
    return getRandomElement(serverEmojis.concat(commonEmojis));
  }
  return getRandomElement(["😎", "😂", "😭", "💀", "😔", "🔥", "🗿", "😈"]);
}

function formatResponse(rawResponse, currentMood) {
  let emojiChance = 0.33;
  if (["roasting", "villain arc"].includes(currentMood)) emojiChance = 0.66;
  else if (currentMood === "chill guy") emojiChance = 0.25;

  const sentences = rawResponse.match(/[^.!?]+[.!?]*/g) || [rawResponse];
  const formatted = sentences
    .map((sentence) => {
      sentence = sentence.trim();
      if (!sentence) return "";
      if (Math.random() < emojiChance) {
        sentence += " " + getRandomElement(["😎", "🔥", "💀"]);
      }
      return sentence;
    })
    .filter((s) => s.length > 0)
    .join(" ");
  return formatted;
}

// Preset Replies for Slash Commands
const startRepliesEmoji = [
  "ayyy i'm awake, ready to roast 😈",
  "yo, i'm live—bring the heat 🔥",
  "woke up, now watch me roast these fools 😎",
  "i'm here, let's get savage 💀",
  "time to get lit, bruv 😈",
];
const startRepliesNoEmoji = [
  "ayyy i'm awake, ready to roast",
  "yo, i'm live—bring the heat",
  "woke up, now watch me roast these fools",
];
const spamStartReplies = [
  "chill, i'm already live, dumbass",
  "save your breath, i’m awake already",
  "hey, stop spamming /start, idiot",
  "i already said i'm live, now zip it",
  "enough already, i’m up",
  "i got it, i'm awake—back off",
  "spamming won't change anything, bruv",
  "i already woke up, moron",
  "stop the noise, i'm already online",
  "yo, i’m awake—get a grip",
];
const stopRepliesEmoji = [
  "fine, i'm out, peace out 😈",
  "i’m ghosting, catch ya later 🔥",
  "i'm off, bye 😎",
  "done here, peace 💀",
  "logging off, later 😈",
];
const stopRepliesNoEmoji = [
  "fine, i'm out, peace out",
  "i’m ghosting, catch ya later",
  "i'm off, bye",
];
const moodPresets = {
  roasting: [
    "k mood switched to roasting 🔥",
    "alright, roast mode on 🔥",
    "now we're roasting, dumbass 🔥",
    "roast mode activated 🔥",
    "roasting now, brace yourself 🔥",
    "roast mode: engaged 🔥",
    "time to roast, mode set 🔥",
    "i'm in roast mode 🔥",
    "roast mode: let's go 🔥",
    "roasting activated, bring it 🔥",
  ],
  neutral: [
    "k mood switched to neutral.",
    "mood set to neutral, i'll listen.",
    "neutral mode on.",
    "i'm in neutral mode now.",
    "mood is now neutral.",
    "neutral mode: active.",
    "i'm set to neutral.",
    "mood switched to neutral.",
    "neutral mode engaged.",
    "i'm in base mode now.",
  ],
  happy: [
    "k mood switched to happy 😊",
    "happy mode on, let's vibe!",
    "i'm feeling happy now!",
    "mood set to happy, good vibes!",
    "happy mode activated!",
    "i'm in a happy mood!",
    "mood changed to happy!",
    "happy mode: engaged!",
    "feeling upbeat, mood is happy!",
    "i'm now happy.",
  ],
  sad: [
    "k mood switched to sad 😔",
    "sad mode on, feeling low.",
    "i'm in a sad mood now.",
    "mood set to sad, life's rough.",
    "sad mode activated.",
    "i'm feeling down, mood is sad.",
    "mood changed to sad.",
    "sad mode: engaged.",
    "i'm now sad.",
    "sad mode: on.",
  ],
  romantic: [
    "k mood switched to romantic 💕",
    "romantic mode on, let's get smooth.",
    "i'm feeling romantic now.",
    "mood set to romantic, vibes on point.",
    "romance activated, let's woo.",
    "i'm in romantic mode.",
    "mood changed to romantic.",
    "romantic mode: engaged.",
    "i'm now lovey-dovey.",
    "romantic mode on.",
  ],
  rizz: [
    "k mood switched to rizz 😏",
    "rizz mode on, watch me charm.",
    "i'm in rizz mode now.",
    "mood set to rizz, let's roll.",
    "rizz activated, smooth talk.",
    "i'm feeling rizz.",
    "mood changed to rizz.",
    "rizz mode: engaged.",
    "i'm full of rizz now.",
    "rizz mode on.",
  ],
  "villain arc": [
    "k mood switched to villain arc 😈",
    "villain mode on, prepare for chaos.",
    "i'm in villain arc mode now.",
    "mood set to villain arc, no mercy.",
    "villain arc activated, bow down.",
    "i'm ruthless now, villain arc on.",
    "mood changed to villain arc.",
    "villain mode: engaged.",
    "i'm now in full villain mode.",
    "villain arc on.",
  ],
  "chill guy": [
    "k mood switched to chill guy 😎",
    "chill mode on, let's take it easy.",
    "i'm in chill guy mode now.",
    "mood set to chill guy, relaxed vibes.",
    "chill mode activated, no offense.",
    "i'm feeling chill now.",
    "mood changed to chill guy.",
    "chill mode: engaged.",
    "i'm now chill, buddy.",
    "chill guy mode on.",
  ],
};

// Personality & Background Details
const personalityDetails = `
Noobhay is a normal guy, a bit overweight and insecure, but he doesn't give a flying shit about what others say—he cares about what he thinks. Sometimes he wonders if his crush will ever talk to him or if he can even approach her. He is the creator of Colour Gang, a Discord server whose members include Red (his closest friend), Ankit (his most trustworthy friend and a great guy), Butter (his BFF), and Beast (his stupid friend).
`;

// Base phrases (always included)
const basePhrases = [
  "ZIGGA OPEN YOUR EYES ARE YOU FOCKINH DUMB",
  "You dumbahh",
  "bro you know you should kys",
  "hell nawh kys zigga",
  "yeah man idc about ts tbh人",
  "stop yapping bitch ahh",
  "bruv ;-;",
  "I'll touch you",
  "aight Ima dip now",
  "GET OU",
];

// ================================
// Global State Variables
// (Moved up so they’re available to all functions)
// ================================
let chatting = false;
let lastReply = "";
let lastStartCommandTime = 0;
const START_SPAM_INTERVAL = 30000; // 30 seconds
let currentMood = "neutral";

// ================================
// Gemini AI Setup & Prompt Construction
// ================================
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

function getToneForMood(mood) {
  switch (mood) {
    case "roasting":
      return "Respond offensively with savage, insulting, and roasting language using Gen Z slang.";
    case "villain arc":
      return "Be extremely offensive, ruthless, and villainous with no chill; insult relentlessly.";
    case "happy":
      return "Keep the tone upbeat, positive, and cheerful using casual slang.";
    case "sad":
      return "Use a melancholic, reflective, and somber tone with casual language.";
    case "romantic":
      return "Be charming, smooth, and romantic with a touch of Gen Z flair.";
    case "rizz":
      return "Be effortlessly cool, smooth, and charismatic using Gen Z slang.";
    case "chill guy":
      return "Respond in a laid-back, polite, and receptive manner using casual language.";
    case "neutral":
    default:
      return "Respond in a neutral, factual tone using casual Gen Z slang.";
  }
}

async function buildGeminiPrompt(userMessage) {
  try {
    const recentRows = await dbQuery(
      `SELECT content FROM chat_messages 
       WHERE timestamp >= datetime('now', '-1 year') 
       ORDER BY timestamp DESC LIMIT 25`
    );
    const recentChat = recentRows.map((r) => r.content).join("\n");

    const skippedRows = await dbQuery(
      `SELECT content FROM chat_messages 
       WHERE skipped = 1 AND timestamp >= datetime('now', '-1 year') 
       ORDER BY timestamp DESC LIMIT 10`
    );
    const skippedChat = skippedRows.map((r) => r.content).join("\n");

    const likeQuery = `%${userMessage}%`;
    const similarRows = await dbQuery(
      `SELECT content FROM chat_messages 
       WHERE timestamp >= datetime('now', '-1 year') AND content LIKE ? 
       ORDER BY timestamp DESC LIMIT 25`,
      [likeQuery]
    );
    const similarChat = similarRows.map((r) => r.content).join("\n");

    const prompt = `
${personalityDetails}

Base phrases (always include): 
${basePhrases.join("\n")}

Tone: ${getToneForMood(currentMood)}
Current mood: ${currentMood}

Recent conversation (last 1 year, up to 25 messages):
${recentChat}

Skipped messages:
${skippedChat}

Similar past messages (if relevant):
${similarChat}

User: ${userMessage}
Reply (use Gen Z slang like "fr", "tbh", "idk", "nvm", "cya"; keep it concise between 15 to 35 words, 1-2 sentences, and ask a question occasionally):
`;
    return prompt;
  } catch (error) {
    logError(error);
    return "";
  }
}

async function chatWithGemini(userId, userMessage) {
  try {
    const prompt = await buildGeminiPrompt(userMessage);
    const result = await model.generateContent(prompt);
    let reply =
      typeof result.response === "string"
        ? result.response
        : result.response.text
        ? result.response.text()
        : "uhhh my brain glitched 💀";

    // Limit each sentence to a max of 40 words and the overall reply to 35 words.
    reply = reply
      .split(/[.!?]+/)
      .filter((sentence) => sentence.trim().length > 0)
      .map((sentence) => {
        const words = sentence.trim().split(/\s+/);
        return words.length > 40 ? words.slice(0, 40).join(" ") : sentence.trim();
      })
      .join(". ") + ".";
    const totalWords = reply.split(/\s+/);
    if (totalWords.length > 35) {
      reply = totalWords.slice(0, 35).join(" ") + ".";
    }

    await dbRun(
      "INSERT INTO chat_messages (user, content, skipped) VALUES (?, ?, ?)",
      [userId, userMessage, 0]
    );
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
    logError(error);
    return "yo my brain glitched, try again 💀";
  }
}

// ================================
// Conversation Tracker & Skip Logic
// ================================
const conversationTracker = new Map();
function shouldReply(message) {
  const channelId = message.channel.id;
  if (!conversationTracker.has(channelId)) {
    conversationTracker.set(channelId, {
      count: 0,
      participants: new Set(),
      skipped: [],
    });
  }
  const tracker = conversationTracker.get(channelId);
  tracker.count++;
  tracker.participants.add(message.author.id);

  let skipThreshold =
    tracker.participants.size > 1 ? Math.floor(Math.random() * 2) + 1 : 1;
  if (tracker.count < skipThreshold) {
    tracker.skipped.push(message.content);
    return false;
  }
  tracker.count = 0;
  return Math.random() >= 0.20;
}

// ================================
// Discord Client & Event Handlers
// ================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.on("interactionCreate", async (interaction) => {
  try {
    // Using isChatInputCommand() for Discord.js v14 slash commands.
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;
    const now = Date.now();

    if (cmd === "start") {
      if (chatting && now - lastStartCommandTime < START_SPAM_INTERVAL) {
        await interaction.reply(
          getRandomElement(spamStartReplies) +
            " " +
            getRandomElement(["😎", "🔥", "💀"])
        );
        lastStartCommandTime = now;
        return;
      }
      lastStartCommandTime = now;
      chatting = true;
      const useEmoji = Math.random() < 0.5;
      const replyText = useEmoji
        ? getRandomElement(startRepliesEmoji)
        : getRandomElement(startRepliesNoEmoji);
      await interaction.reply(replyText + " " + getRandomElement(["😎", "🔥", "💀"]));
    } else if (cmd === "stop") {
      chatting = false;
      const useEmoji = Math.random() < 0.5;
      const replyText = useEmoji
        ? getRandomElement(stopRepliesEmoji)
        : getRandomElement(stopRepliesNoEmoji);
      await interaction.reply(replyText + " " + getRandomElement(["😎", "🔥", "💀"]));
    } else if (cmd === "mood") {
      const chosenMood = interaction.options.getString("type")?.toLowerCase();
      const availableMoods = [
        "roasting",
        "neutral",
        "happy",
        "sad",
        "romantic",
        "rizz",
        "villain arc",
        "chill guy",
      ];
      if (!chosenMood || !availableMoods.includes(chosenMood)) {
        await interaction.reply("Available moods: " + availableMoods.join(", "));
        return;
      }
      currentMood = chosenMood;
      const moodResponse = getRandomElement(moodPresets[currentMood]);
      await interaction.reply(moodResponse);
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

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    await dbRun(
      "INSERT INTO chat_messages (user, content, skipped) VALUES (?, ?, ?)",
      [message.author.id, message.content, 0]
    );
    if (!chatting) return;

    const triggers = ["meme", "funny", "gif"];
    if (
      triggers.some((t) => message.content.toLowerCase().includes(t)) &&
      Math.random() < 0.10
    ) {
      if (Math.random() < 0.5) {
        try {
          const response = await fetch("https://www.reddit.com/r/memes/random.json", {
            headers: { "User-Agent": "noobhay-tripathi-bot/1.0" },
          });
          if (!response.ok) {
            logError(`Reddit API Error: ${response.status} ${response.statusText}`);
            message.channel.send("couldn't fetch a meme, bruh");
          } else {
            const data = await response.json();
            const memeUrl =
              data[0]?.data?.children[0]?.data?.url || "couldn't fetch a meme, bruh";
            message.channel.send(memeUrl);
          }
        } catch (error) {
          logError(error);
          message.channel.send("couldn't fetch a meme, bruh");
        }
      } else {
        try {
          const url = `https://g.tenor.com/v1/search?q=${encodeURIComponent(
            "funny"
          )}&key=${TENOR_API_KEY}&limit=1`;
          const response = await fetch(url);
          if (!response.ok) {
            logError(`Tenor API Error: ${response.status} ${response.statusText}`);
            message.channel.send("couldn't fetch a gif, bruh");
          } else {
            const data = await response.json();
            if (data.results && data.results.length > 0) {
              const gifUrl =
                data.results[0].media[0]?.gif?.url || "couldn't fetch a gif, bruh";
              message.channel.send(gifUrl);
            } else {
              logError("No GIF results found.");
              message.channel.send("couldn't find a gif, bruh");
            }
          }
        } catch (error) {
          logError(error);
          message.channel.send("couldn't fetch a gif, bruh");
        }
      }
      return;
    }

    if (!shouldReply(message)) return;

    const replyContent = await chatWithGemini(message.author.id, message.content);
    if (replyContent === lastReply) return;
    lastReply = replyContent;

    const finalReply = formatResponse(replyContent, currentMood);
    const sentences = finalReply.match(/[^.!?]+[.!?]*/g) || [finalReply];
    const limitedReply = sentences.slice(0, 5).join(" ").trim();

    message.channel.send(limitedReply).catch((err) => logError(err));
  } catch (error) {
    logError(error);
  }
});

client.on("guildCreate", async (guild) => {
  try {
    const botMember = await guild.members.fetch(client.user.id);
    let role = guild.roles.cache.find((r) => r.name === "NOOBHAY");
    if (!role) {
      role = await guild.roles.create({
        name: "NOOBHAY",
        color: "RED",
        reason: "Assigning NOOBHAY role to the bot upon joining.",
      });
    }
    if (!botMember.roles.cache.has(role.id)) {
      await botMember.roles.add(role);
    }
  } catch (error) {
    logError(error);
  }
});

// ================================
// Express Server for Uptime Monitoring
// ================================
const app = express();
app.get("/", (req, res) => res.send("noobhay tripathi is alive! 🚀"));
app.listen(PORT, () =>
  console.log(`✅ Web server running on port ${PORT}`)
);

// ================================
// Bot Login
// ================================
client.login(DISCORD_TOKEN).catch((err) => logError(err));
