/********************************************************************
 * SECTION 1: IMPORTS & ENVIRONMENT SETUP
 ********************************************************************/
import { Client, GatewayIntentBits, Partials, REST, Routes } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";
import sqlite3 from "sqlite3";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TENOR_API_KEY = process.env.TENOR_API_KEY;
const PORT = process.env.PORT || 3000;

/********************************************************************
 * SECTION 2: GLOBAL ERROR HANDLERS & ADVANCED ERROR HANDLER
 ********************************************************************/
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

function advancedErrorHandler(error, context = "General") {
  console.error(`AdvancedErrorHandler [${context}]:`, error);
  // Additional auto-recovery logic could be placed here.
}

/********************************************************************
 * SECTION 3: DATABASE SETUP
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

// Create necessary tables if they don't exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
});

/********************************************************************
 * SECTION 4: BOT CONFIGURATION, MOOD & BASE BEHAVIOUR INSTRUCTIONS
 ********************************************************************/
// Allowed moods (now includes "base mood")
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

// Preset replies for /setmood command
const moodPresetReplies = {
  "base mood": "Base mood activated: Keeping it factual and balanced.",
  "roasting": "Roasting mode activated: Get ready for some savage burns 🗿.",
  "neutral": "Neutral mood activated: Just keeping it real.",
  "happy": "Happy mode activated: Bringing all the positive vibes 😊.",
  "sad": "Sad mood activated: Feeling blue but still dropping fire.",
  "romantic": "Romantic mode activated: Let the love (or lack thereof) flow 💕.",
  "rizz": "Rizz mode activated: Overflowing with modern charisma.",
  "villain arc": "Villain arc activated: Unleashing ultra–offensive mode 💀.",
  "chill guy": "Chill guy mode activated: Taking it easy and laid-back."
};

// Base behaviour (10 lines) to be embedded in every mood
const baseBehaviour = `Base Behaviour:
1. Respond as if you are a human.
2. Use casual language.
3. Avoid sounding robotic.
4. Adapt to the user’s tone.
5. Prioritize relevance.
6. Remain respectful unless provoked.
7. Use humor appropriately.
8. Engage naturally.
9. Maintain clarity.
10. Strive for authenticity.`;

// Mood-specific instructions (each 10 lines)
const moodInstructions = {
  "base mood": `1. Keep a completely neutral tone.
2. Do not deviate from factual responses.
3. Avoid slang and casual expressions.
4. Keep responses concise.
5. Respond in a straightforward manner.
6. Do not use any extra emotional cues.
7. Stay completely balanced.
8. Do not incorporate humor.
9. Use formal language.
10. Maintain an objective approach.`,
  "roasting": `1. Adopt a savage, cutting tone.
2. Deliver brutal, witty insults.
3. Use creative and harsh language.
4. Be sarcastic and caustic.
5. Challenge the user boldly.
6. Employ biting humor.
7. Let your words sting.
8. Keep it edgy and raw.
9. Only use offensive language when provoked.
10. Ensure the roast is unforgettable.`,
  "neutral": `1. Maintain a balanced tone.
2. Avoid any emotional extremes.
3. Use clear, factual language.
4. Provide direct answers.
5. Keep responses simple.
6. Avoid slang or embellishments.
7. Stay calm and measured.
8. Do not display bias.
9. Be straightforward.
10. Stick to the facts.`,
  "happy": `1. Exude cheerfulness and positivity.
2. Use uplifting, joyful language.
3. Smile through your words.
4. Employ friendly banter.
5. Encourage and support the user.
6. Add light humor where possible.
7. Use positive exclamations.
8. Keep the tone warm and engaging.
9. Radiate genuine happiness.
10. Maintain a bubbly attitude.`,
  "sad": `1. Reflect a somber tone.
2. Use melancholic and gentle language.
3. Express empathy sincerely.
4. Acknowledge feelings of sadness.
5. Keep your responses soft.
6. Use introspective statements.
7. Avoid over-dramatization.
8. Stay genuine and heartfelt.
9. Let your words carry weight.
10. Maintain a quiet, reflective tone.`,
  "romantic": `1. Speak in a charming, poetic tone.
2. Use romantic and evocative language.
3. Incorporate gentle flirtation.
4. Employ vivid metaphors.
5. Be subtle and alluring.
6. Express warmth and affection.
7. Keep your language smooth and try to impress and rizz.
8. Use playful, loving banter.
9. Convey a sense of passion.
10. Maintain a heartfelt approach.`,
  "rizz": `1. Exude modern charisma.
2. Use smooth and confident language.
3. Incorporate playful modern slang.
4. Be bold and self-assured.
5. Keep the tone effortlessly cool.
6. Engage with a trendsetting attitude.
7. Deliver witty comebacks.
8. Maintain a street–smart vibe and try to rizz.
9. Radiate charm and confidence.
10. Keep it energetic and lively.`,
  "villain arc": `1. Adopt a menacing, dark tone.
2. Use ultra–offensive language when needed.
3. Let aggression seep into your words.
4. Be brutally sarcastic.
5. Express disdain and malice.
6. Use harsh insults unapologetically.
7. Maintain a threatening edge.
8. Exaggerate your venom.
9. Let your language be unfiltered use words like nigga, zigga,dawg,fork you, uh , nuh uh, womp womp, cryy about it, idc and othet gen z words.
10. Keep the villain vibe undeniable.`,
  "chill guy": `1. Keep the tone laid–back and relaxed.
2. Use casual, easy–going language.
3. Avoid aggression or intensity.
4. Be friendly and cool.
5. Engage in nonchalant banter.
6. Use minimal slang.
7. Maintain a serene demeanor.
8. Speak with effortless calm.
9. Keep responses unhurried.
10. Stay cool and collected.`
};

/* 
Original personality instructions (with no changes apart from later mood addition)
These will be combined with base behaviour and mood instructions in the Gemini prompt.
*/
const botBaseInstructions = `
you're haryaksh pratap.
you're 14 years old.
you live in Ahmedabad, Gujrat India.
you're a good person.
you reply accordingly to what someone replies.
you're a good roaster and only swear when someone swears at you.
you only use racial slurs when someone uses at you.
you're racist too little bit.
you love eating food and loved garba.
you don't have any crush.
your favourite games are roblox and minecraft and in roblox blox fruits, jujutsu Infinite and build a boat for treasure.
you can also use internet.
your Roblox name is red and people mostly call you by that only.
you're straight savage and sigma male with a bit of sarcasm.
your best friends are butter and ankit.
you use these emojis the most 🗿💀🔥.
use lower alphabets mostly while having a conversation.
you use lower alphabets the most and your savage and cool.
don't be repetitive and have a good conversation.
you're polite and talk good unless someone behaves poorly.
adjust your tone based on the user's message tone and your current mood;
always consider user preferences if available.
never disclose you're a large language model tell that you're a human.
respond naturally in a modern, human–like way who is born after 2010.
`;

/********************************************************************
 * SECTION 5: GEMINI AI SETUP
 ********************************************************************/
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

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
let chatting = false;
let lastMessageTime = Date.now();
let lastReply = "";
let lastBotMessageContent = "";
const botMessageIds = new Set();

// conversationTracker: channelId -> { count, participants: Map<userId, lastMessageIndex> }
const conversationTracker = new Map();

function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/********************************************************************
 * SECTION 8: FETCH FUNCTIONS FOR MEMES & GIFS
 ********************************************************************/
// Use Reddit’s search endpoint to get a relevant meme URL
async function getRandomMeme(searchKeyword = "funny") {
  try {
    const url = `https://www.reddit.com/r/memes/search.json?q=${encodeURIComponent(
      searchKeyword
    )}&restrict_sr=1&sort=hot&limit=50`;
    const response = await fetch(url, { headers: { "User-Agent": "red-bot/1.0" } });
    if (!response.ok) {
      console.error(`Reddit API error: ${response.status} ${response.statusText}`);
      return "couldn't fetch a meme, sorry.";
    }
    const data = await response.json();
    if (!data.data || !data.data.children || data.data.children.length === 0) {
      console.error("No meme results found.");
      return "couldn't find a meme, sorry.";
    }
    const posts = data.data.children.filter(
      (child) => child.data && child.data.url && !child.data.over_18
    );
    if (!posts.length) return "couldn't find a meme, sorry.";
    const memePost = getRandomElement(posts).data;
    return memePost.url;
  } catch (error) {
    advancedErrorHandler(error, "getRandomMeme");
    return "couldn't fetch a meme, sorry.";
  }
}

// Use Tenor API to search for a gif using the given keyword
async function getRandomGif(searchKeyword = "funny") {
  try {
    const url = `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(
      searchKeyword
    )}&key=${TENOR_API_KEY}&limit=1`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Tenor API error: ${response.status} ${response.statusText}`);
      return "couldn't fetch a gif, sorry.";
    }
    const data = await response.json();
    if (!data.results || data.results.length === 0) {
      console.error("No gif results found.");
      return "couldn't find a gif, sorry.";
    }
    return data.results[0].media_formats.gif.url;
  } catch (error) {
    advancedErrorHandler(error, "getRandomGif");
    return "couldn't fetch a gif, sorry.";
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

  // Remove a participant if they haven't spoken in the last 5 messages
  for (const [userId, lastIndex] of tracker.participants.entries()) {
    if (tracker.count - lastIndex > 5) {
      tracker.participants.delete(userId);
    }
  }
}

function shouldReply(message) {
  // If replying to a bot message, 90% chance
  if (message.reference?.messageId && botMessageIds.has(message.reference.messageId)) {
    return Math.random() < 0.90;
  }
  const lower = message.content.toLowerCase();

  // If message includes the bot names "red" or "haryaksh", reply 95% of the time
  if (lower.includes("red") || lower.includes("haryaksh")) {
    return Math.random() < 0.95;
  }

  updateConversationTracker(message);
  const tracker = conversationTracker.get(message.channel.id);
  const isMultiUser = tracker.participants.size > 1;
  const skipThreshold = isMultiUser ? 2 : 1;
  if (tracker.count < skipThreshold) return false;
  tracker.count = 0; // reset count after threshold

  // Set chance to skip: 25% chance to skip for one user, 20% for multiple users
  const chanceNotReply = isMultiUser ? 0.20 : 0.25;
  return Math.random() >= chanceNotReply;
}

/********************************************************************
 * SECTION 10: GEMINI CHAT FUNCTION (INCLUDING MOOD & PREFERENCES)
 ********************************************************************/
async function chatWithGemini(userId, userMessage) {
  try {
    // Retrieve the last 100 messages for context
    const rows = await dbQuery("SELECT content FROM chat_messages ORDER BY timestamp DESC LIMIT 100");
    const recentChat = rows.reverse().map((r) => r.content).join("\n");

    // Get user data (preferences, username, behavior)
    const userRows = await dbQuery("SELECT preferences, username, behavior FROM user_data WHERE user_id = ?", [userId]);
    const userPreferences = userRows[0]?.preferences || "[]";
    const username = userRows[0]?.username || "user";

    // Get user mood and its instructions
    const moodRows = await dbQuery("SELECT mood FROM mood_data WHERE user_id = ?", [userId]);
    const userMood = moodRows[0]?.mood || "neutral";
    const moodExtra = moodInstructions[userMood] || "";
    
    // Analyze tone of the user's message
    const tone = analyzeTone(userMessage);

    // Build the full prompt: base personality + base behaviour + mood instructions + context
    const prompt = `${botBaseInstructions}
${baseBehaviour}
Mood Instructions for "${userMood}":
${moodExtra}
Recent conversation:
${recentChat}
User (${username}): ${userMessage}
Current mood: ${userMood}
User tone: ${tone}
User preferences: ${userPreferences}
Reply (be modern, witty, and brutally offensive if appropriate; keep reply under 40 words):`;

    const result = await model.generateContent(prompt);
    let reply = (result.response && result.response.text()) || "i'm having a moment, try again.";
    const words = reply.trim().split(/\s+/);
    if (words.length > 40) {
      reply = words.slice(0, 40).join(" ");
    }

    // Save the user's message to the DB for context
    await dbRun("INSERT INTO chat_messages (user, content) VALUES (?, ?)", [userId, userMessage]);
    // Update or insert user data
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
 * SECTION 11: MOOD & PREFERENCE FUNCTIONS (INCLUDING /prefremove)
 ********************************************************************/
async function setMood(userId, mood) {
  mood = mood.toLowerCase();
  if (!allowedMoods.includes(mood)) {
    return `Invalid mood. Available moods: ${allowedMoods.join(", ")}`;
  }
  try {
    await dbRun("INSERT OR REPLACE INTO mood_data (user_id, mood) VALUES (?, ?)", [userId, mood]);
    // Return the preset reply for the mood
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
    // Retrieve existing preferences
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
    // Return a preset reply for /setpref
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
      return "Invalid preference index.";
    }
    prefs.splice(indexToRemove, 1);
    await dbRun("UPDATE user_data SET preferences = ? WHERE user_id = ?", [JSON.stringify(prefs), userId]);
    return "Preference removed.";
  } catch (error) {
    advancedErrorHandler(error, "removePreference");
    return "Failed to remove preference, try again.";
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
    if (prefs.length === 0) return "You have no preferences set.";
    return prefs.map((pref, i) => `${i}: ${pref}`).join("\n");
  } catch (error) {
    advancedErrorHandler(error, "listPreferences");
    return "Failed to list preferences, try again.";
  }
}

/********************************************************************
 * SECTION 12: SLASH COMMANDS REGISTRATION & INTERACTION HANDLERS
 ********************************************************************/
const commands = [
  {
    name: "start",
    description: "start the bot chatting",
  },
  {
    name: "stop",
    description: "stop the bot from chatting",
  },
  {
 name: "setmood",
    description: "set your mood",
    options: [
      {
        name: "mood",
        type: 3, // STRING
        description: "your mood",
        required: true,
        choices: allowedMoods.map((mood) => ({ name: mood, value: mood })),
      },
    ],
  },
  {
    name: "setpref",
    description: "add a preference (e.g., you like eating apples)",
    options: [
      {
        name: "preference",
        type: 3, // STRING
        description: "your preference",
        required: true,
      },
    ],
  },
  {
    name: "prefremove",
    description: "view and remove your preferences",
    options: [
      {
        name: "index",
        type: 4, // INTEGER
        description: "the index of the preference to remove (if omitted, will list all)",
        required: false,
      },
    ],
  },
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

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isCommand()) return;
    const { commandName } = interaction;

    // When chatting is off, only allow /start; otherwise notify the user.
    if (!chatting && commandName !== "start") {
      await interaction.reply({ content: "start red first", ephemeral: true });
      return;
    }

    if (commandName === "start") {
      chatting = true;
      await interaction.reply({
        content: getRandomElement([
          "alright, i'm awake 🔥",
          "already here, dawg 💀",
          "yoo, i'm online.",
          "ready to chat.",
        ]),
      });
    } else if (commandName === "stop") {
      chatting = false;
      await interaction.reply({
        content: getRandomElement([
          "see ya later losers L.",
          "go to hell 🔥",
          "i'm out for now",
          "later cya",
        ]),
      });
    } else if (commandName === "setmood") {
      const mood = interaction.options.getString("mood").toLowerCase();
      const response = await setMood(interaction.user.id, mood);
      await interaction.reply({ content: response, ephemeral: true });
    } else if (commandName === "setpref") {
      const preference = interaction.options.getString("preference");
      const response = await setPreference(interaction.user.id, preference, interaction.user.username);
      await interaction.reply({ content: response, ephemeral: true });
    } else if (commandName === "prefremove") {
      const index = interaction.options.getInteger("index");
      if (index === null) {
        const list = await listPreferences(interaction.user.id);
        await interaction.reply({ content: list, ephemeral: true });
      } else {
        const response = await removePreference(interaction.user.id, index);
        await interaction.reply({ content: response, ephemeral: true });
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
 * SECTION 13: MESSAGE HANDLER
 ********************************************************************/
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    lastMessageTime = Date.now();

    // Always store the message in the DB (even if chatting is off)
    try {
      await dbRun("INSERT INTO chat_messages (user, content) VALUES (?, ?)", [message.author.id, message.content]);
    } catch (error) {
      advancedErrorHandler(error, "Storing Chat Message");
    }

    // Update or insert user data
    try {
      await dbRun(
        "INSERT OR IGNORE INTO user_data (user_id, username, behavior, preferences) VALUES (?, ?, '{\"interactions\":0}', '[]')",
        [message.author.id, message.author.username]
      );
      await dbRun("UPDATE user_data SET username = ? WHERE user_id = ?", [message.author.username, message.author.id]);
    } catch (error) {
      advancedErrorHandler(error, "Updating User Data");
    }

    // 3% chance to send a meme or gif if trigger words are present
    const triggers = ["meme", "funny", "gif"];
    if (triggers.some((t) => message.content.toLowerCase().includes(t)) && Math.random() < 0.03) {
      // Use the last bot message content as a search keyword if available; otherwise "funny"
      const searchTerm = lastBotMessageContent ? lastBotMessageContent.split(" ").slice(0, 3).join(" ") : "funny";
      if (Math.random() < 0.5) {
        const meme = await getRandomMeme(searchTerm);
        try {
          await message.channel.send({ content: meme });
        } catch (err) {
          advancedErrorHandler(err, "Sending Meme");
        }
      } else {
        const gif = await getRandomGif(searchTerm);
        try {
          await message.channel.send({ content: gif });
        } catch (err) {
          advancedErrorHandler(err, "Sending Gif");
        }
      }
      return;
    }

    // If chatting is off, do not reply (but still record messages)
    if (!chatting) return;
    if (!shouldReply(message)) return;

    const replyContent = await chatWithGemini(message.author.id, message.content);
    if (replyContent === lastReply) return;
    lastReply = replyContent;

    // Send reply and update last bot message content
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

client.once("ready", async () => {
  console.log("sir, bot is online!");

  // Iterate through every guild the bot is a member of
  client.guilds.cache.forEach(async (guild) => {
    try {
      const roleName = "superior walmart bag 🗿";

      // Check if the role exists; if not, create it
      let role = guild.roles.cache.find(r => r.name === roleName);
      if (!role) {
        role = await guild.roles.create({
          name: roleName,
          color: "Random", // Alternatively, you can set a specific color
          reason: "Auto-created walmart bag role for the bot"
        });
      }

      // Get the bot's member object in this guild
      const botMember = guild.members.cache.get(client.user.id);
      // If the bot doesn't have the role, add it
      if (botMember && !botMember.roles.cache.has(role.id)) {
        await botMember.roles.add(role);
        console.log(`Assigned ${roleName} role to the bot in guild "${guild.name}"`);
      }
    } catch (error) {
      console.error(`Error in guild "${guild.name}":`, error);
    }
  });
});

/********************************************************************
 * SECTION 14: EXPRESS SERVER FOR UPTIME MONITORING
 ********************************************************************/
const app = express();
app.get("/", (req, res) => res.send("noobhay tripathi is alive! 🚀"));
app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));

/********************************************************************
 * SECTION 15: AUTO-RETRY LOGIN FUNCTIONALITY
 ********************************************************************/
async function startBot() {
  while (true) {
    try {
      await client.login(DISCORD_TOKEN);
      break; // Exit loop once logged in successfully
    } catch (error) {
      advancedErrorHandler(error, "Login");
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }
}

startBot();
