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
    mood TEXT DEFAULT 'roasting'
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

function getRandomEmoji(message) {
  if (message.guild && message.guild.emojis.cache.size > 0) {
    const emojis = Array.from(message.guild.emojis.cache.values());
    return getRandomElement(emojis).toString();
  }
  return getRandomElement(["💀", "😎", "🔥", "🤙", "🙌"]);
}

// -------------------------
// Conversation History Functions
// -------------------------
async function getRecentChatHistory() {
  try {
    const rows = await dbQuery(
      `SELECT content FROM chat_messages 
       WHERE timestamp >= datetime('now', '-1 year') 
       ORDER BY timestamp DESC LIMIT 25`
    );
    return rows.map(r => r.content).join("\n");
  } catch (err) {
    logError(err);
    return "";
  }
}

async function searchChatHistory(query) {
  try {
    const likeQuery = `%${query}%`;
    const rows = await dbQuery(
      `SELECT content FROM chat_messages 
       WHERE timestamp >= datetime('now', '-1 year') AND content LIKE ? 
       ORDER BY timestamp DESC LIMIT 25`,
      [likeQuery]
    );
    return rows.map(r => r.content).join("\n");
  } catch (err) {
    logError(err);
    return "";
  }
}

// -------------------------
// Gemini AI Setup & Prompt
// -------------------------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Global mood variable (default "roasting")
let currentMood = "roasting";

// Gemini prompt includes current mood
function getGeminiPrompt(userMessage, recentChat, similarChat) {
  return `
you are noobhay tripathi, a 14-year-old human living in india who loves playing roblox.
your style is offensive, savage, and cool with a knack for roasting.
your tone is direct, brutally honest and uses gen z slang.
current mood: ${currentMood}.
keep replies concise: 15 to 35 words, 1-2 sentences (max 5 sentences).
learn from chat history and incorporate context.
preset phrases if needed: "zigga open your eyes are you fockinh dumb", "you dumbahh", "bro you know you should kys", "hell nawh kys zigga", "yeah man idc about ts tbh 💀🙏", "stop yapping bitch ahh", "bruv ;-;", "i’ll touch you", "aight ima dip now", "get ou"
recent conversation (last 1 year, up to 25 messages):
${recentChat}
similar past messages (if any):
${similarChat}
user: ${userMessage}
reply (be savage, offensive, and cool, and ask a question sometimes):
`;
}

async function chatWithGemini(userId, userMessage) {
  try {
    const recentChat = await getRecentChatHistory();
    const similarChat = await searchChatHistory(userMessage);
    const prompt = getGeminiPrompt(userMessage, recentChat, similarChat);
    const result = await model.generateContent(prompt);
    let reply = result.response.text() || "uhhh, my brain glitched 💀";

    // Split into sentences and ensure each sentence has no more than 40 words
    reply = reply
      .split(/[.!?]+/)
      .filter(s => s.trim().length > 0)
      .map(sentence => {
        const words = sentence.trim().split(/\s+/);
        return words.length > 40 ? words.slice(0, 40).join(" ") : sentence.trim();
      })
      .join(". ") + ".";
      
    // Limit overall reply to 35 words maximum
    const totalWords = reply.split(/\s+/);
    if (totalWords.length > 35) {
      reply = totalWords.slice(0, 35).join(" ") + ".";
    }

    // Save user message in DB for future context
    await dbRun("INSERT INTO chat_messages (user, content, skipped) VALUES (?, ?, ?)", [userId, userMessage, 0]);
    await dbRun("INSERT OR IGNORE INTO user_data (user_id, behavior) VALUES (?, ?)", [userId, '{"interactions":0}']);
    await dbRun("UPDATE user_data SET behavior = json_set(behavior, '$.interactions', (json_extract(behavior, '$.interactions') + 1)) WHERE user_id = ?", [userId]);

    return reply;
  } catch (error) {
    logError(error);
    return "yo, my brain glitched, try again 💀";
  }
}

// -------------------------
// Conversation Skip & Tracking
// -------------------------
const conversationTracker = new Map(); // key: channel id -> { count, participants: Set, skipped: [] }
function shouldReply(message) {
  const channelId = message.channel.id;
  if (!conversationTracker.has(channelId)) {
    conversationTracker.set(channelId, { count: 0, participants: new Set(), skipped: [] });
  }
  const tracker = conversationTracker.get(channelId);
  tracker.count++;
  tracker.participants.add(message.author.id);

  // For group conversations, skip threshold = 2; for solo, threshold = 1.
  if (tracker.count < (tracker.participants.size > 1 ? 2 : 1)) {
    tracker.skipped.push(message.content);
    return false;
  }
  // Chance not to reply: 10% for group, 20% for solo.
  const chanceNotReply = tracker.participants.size > 1 ? 0.10 : 0.20;
  tracker.count = 0; // reset counter after threshold
  return Math.random() >= chanceNotReply;
}

// -------------------------
// Preset Replies for Slash Commands (40 each)
// -------------------------
const startReplies = [
  "ayyy, i'm up and spittin' fire, what's good?",
  "yo, i'm live, ready to roast all day.",
  "i'm awake and savage, let's get this chaos.",
  "hey, i'm here to burn fools—buckle up.",
  "i'm back, ready to dish out real talk.",
  "yo, i'm in—prepare for a roast session.",
  "i'm live, let's cut the crap and roast.",
  "ayyy, time to get savage. who’s ready?",
  "yo, i'm awake—bring on the burn.",
  "i'm here, savage mode on—let's go.",
  "ayyy, i'm up, ready to roast these clowns.",
  "yo, i'm live and i ain't holdin' back.",
  "i'm here to slice through the BS.",
  "ayyy, i'm on—let the savage session begin.",
  "yo, i'm awake, prepare for some real talk.",
  "i'm live, ready to drop brutal truth.",
  "ayyy, i'm up and feelin' extra savage today.",
  "yo, i'm here to roast like there's no tomorrow.",
  "i'm awake—time to serve some cold facts.",
  "ayyy, i'm live—let the offensive fun begin.",
  "yo, i'm up—ready to tear down the nonsense.",
  "i'm here—let's roast with no mercy.",
  "ayyy, i'm awake—ready to drop savage lines.",
  "yo, i'm live—bring on the madness.",
  "i'm here, time to roast. buckle up.",
  "ayyy, i'm up and ready—let's get brutal.",
  "yo, i'm live and i ain't holding back.",
  "i'm awake—ready to bring the heat.",
  "ayyy, i'm here—let the savage takeover begin.",
  "yo, i'm live—here to offend.",
  "i'm up—time for raw truth, no filter.",
  "ayyy, i'm awake—straight into savage mode.",
  "yo, i'm live—get ready for some raw truth.",
  "i'm here—ready to roast with no apologies.",
  "ayyy, i'm up—let's burn these clowns.",
  "yo, i'm live—kick off the savage fest.",
  "i'm awake—about to get offensive.",
  "ayyy, i'm live—dropping brutal truth.",
  "yo, i'm up—let the savage revolution start."
];

const spamStartReplies = [
  "chill, i'm already live, no need to spam.",
  "yo, relax—i'm already in savage mode.",
  "hey, stop pressing /start, i'm here.",
  "save your energy—i got this already.",
  "dude, i got it—no spamming needed.",
  "calm down, i'm up and roasting.",
  "spamming /start won't wake me up more.",
  "bro, i said i'm live—cut it out.",
  "i'm already here, so stop the spam.",
  "chill out, my savage mode is on.",
  "yo, i heard you the first time.",
  "save it—i'm already in action.",
  "hey, no need to repeat yourself.",
  "i'm live, no more /start please.",
  "spamming won't make me any savager.",
  "i'm already burning—relax.",
  "stop hitting /start, i'm here.",
  "dude, i already said i'm live.",
  "i'm awake, no need to shout /start.",
  "chill, i'm already in the game.",
  "hey, i got it—i'm already up.",
  "spamming won't make the roast hotter.",
  "i'm live—no need for extra /start.",
  "yo, i already said i'm ready.",
  "save your spam—i'm on.",
  "dude, i'm already in savage mode.",
  "hey, quit it—i'm awake.",
  "i'm here, no need to spam.",
  "chill, message received loud and clear.",
  "yo, i'm live—stop repeating.",
  "dude, i'm already rocking this.",
  "no more spamming—i'm here.",
  "hey, i got the memo—i'm awake.",
  "i'm live—relax, no more /start.",
  "bro, spamming ain't cool.",
  "stop it—i'm already in action.",
  "chill out, i'm here—no need to spam."
];

const stopReplies = [
  "alright, i'm out—catch you later.",
  "peace out—i'm signing off.",
  "i'm ghosting now, bye.",
  "later—time to dip.",
  "i'm done here, see ya.",
  "catch you on the flip side.",
  "i'm off, peace.",
  "later—keep it savage.",
  "i'm logging off, bye.",
  "see ya—i'm out.",
  "i'm bailing now, later.",
  "peace—i'm out.",
  "i'm out, don't miss me.",
  "later, i gotta dip.",
  "i'm signing off—peace out.",
  "bye—i'm disappearing now.",
  "i'm off—catch you later.",
  "later—i'm ghosting.",
  "i'm out—peace and love.",
  "bye, i'm checking out.",
  "i'm logging off—see ya.",
  "peace out—i'm done.",
  "i'm out—catch you on the flip.",
  "later, i'm off.",
  "i'm gone, peace.",
  "bye—i'm fading away.",
  "i'm signing off, later.",
  "peace—i'm out now.",
  "i'm leaving, see ya.",
  "later—off to roast elsewhere.",
  "i'm done, peace out.",
  "bye—i'm out for now.",
  "i'm off, take care.",
  "peace out—i'm bouncing.",
  "i'm out, see ya soon.",
  "later—i'm done here.",
  "i'm signing off, later.",
  "peace, i'm out.",
  "i'm leaving—catch you later.",
  "bye, i'm done for now."
];

// -------------------------
// Discord Client Setup
// -------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

let chatting = false;
let lastReply = "";
let lastStartCommandTime = 0; // for spam detection on /start
const START_SPAM_INTERVAL = 30000; // 30 seconds

// -------------------------
// Slash Commands Handling (/start, /stop, /mood)
// -------------------------
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isCommand()) return;
    const command = interaction.commandName;

    if (command === "start") {
      const now = Date.now();
      // If /start is used within 30 seconds, use spamStartReplies
      if (now - lastStartCommandTime < START_SPAM_INTERVAL) {
        await interaction.reply(getRandomElement(spamStartReplies) + " " + getRandomElement(["💀", "😎", "🔥"]));
      } else {
        // Even after 30 seconds, we still reply with a savage tone from startReplies
        await interaction.reply(getRandomElement(startReplies) + " " + getRandomElement(["💀", "😎", "🔥"]));
      }
      lastStartCommandTime = now;
      chatting = true;
    } else if (command === "stop") {
      chatting = false;
      await interaction.reply(getRandomElement(stopReplies) + " " + getRandomElement(["💀", "😎", "🔥"]));
    } else if (command === "mood") {
      // /mood command can either show the current mood or set a new mood
      const moodArg = interaction.options.getString("mood");
      const validMoods = ["roasting", "neutral", "happy", "sad", "romantic", "rizz", "villain arc", "chill guy"];
      if (moodArg) {
        if (validMoods.includes(moodArg.toLowerCase())) {
          currentMood = moodArg.toLowerCase();
          // Optionally, update in DB for persistent mood per user
          await dbRun("INSERT OR REPLACE INTO mood_data (user_id, mood) VALUES (?, ?)", [interaction.user.id, currentMood]);
          await interaction.reply(`mood set to ${currentMood} 😎`);
        } else {
          await interaction.reply(`invalid mood. valid moods are: ${validMoods.join(", ")}`);
        }
      } else {
        await interaction.reply(`current mood is ${currentMood} 😎`);
      }
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
// Main Message Handler
// -------------------------
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    // Always store incoming messages for context and learning
    await dbRun("INSERT INTO chat_messages (user, content, skipped) VALUES (?, ?, ?)", [message.author.id, message.content, 0]);

    if (!chatting) return;

    // 10% chance to respond with a meme or gif if trigger words are detected
    const triggers = ["meme", "funny", "gif"];
    if (triggers.some(t => message.content.toLowerCase().includes(t)) && Math.random() < 0.10) {
      if (Math.random() < 0.5) {
        const meme = await (async () => {
          try {
            const response = await fetch("https://www.reddit.com/r/memes/random.json", {
              headers: { "User-Agent": "noobhay-tripathi-bot/1.0" }
            });
            if (!response.ok) throw new Error(`Reddit API Error: ${response.status}`);
            const data = await response.json();
            return data[0]?.data?.children[0]?.data?.url || "couldn't fetch a meme, bruh";
          } catch (err) {
            logError(err);
            return "couldn't fetch a meme, bruh";
          }
        })();
        message.channel.send(meme);
      } else {
        const gif = await (async () => {
          try {
            const url = `https://g.tenor.com/v1/search?q=${encodeURIComponent("funny")}&key=${TENOR_API_KEY}&limit=1`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Tenor API Error: ${response.status}`);
            const data = await response.json();
            if (data.results && data.results.length > 0) {
              return data.results[0].media[0]?.gif?.url || "couldn't fetch a gif, bruh";
            } else {
              throw new Error("No GIF results found.");
            }
          } catch (err) {
            logError(err);
            return "couldn't fetch a gif, bruh";
          }
        })();
        message.channel.send(gif);
      }
      return;
    }

    // Decide whether to reply based on conversation tracking
    if (!shouldReply(message)) return;

    const replyContent = await chatWithGemini(message.author.id, message.content);
    if (replyContent === lastReply) return;
    lastReply = replyContent;

    // Append one random emoji (not spammy)
    const emoji = getRandomEmoji(message);
    const finalReply = `${replyContent} ${emoji}`;

    // Limit to maximum of 5 sentences
    const sentences = finalReply.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const limitedReply = sentences.slice(0, 5).join(". ") + ".";
    
    message.channel.send(limitedReply).catch(err => logError(err));
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
// Log In the Bot
// -------------------------
client.login(DISCORD_TOKEN).catch(err => logError(err));
