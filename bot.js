require('dotenv').config();  // Loads environment variables from a .env file
const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } = require('discord.js');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');

// Retrieve API keys from environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;  // OpenAI API key for ChatGPT
const REDDIT_MEME_API = "https://www.reddit.com/r/memes/top.json?limit=50&t=day";
const TENOR_API_KEY = process.env.TENOR_API_KEY;  // Tenor API key for GIFs

// Initialize the Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Channel]
});

// Web Server Setup (For keeping the bot alive on Render)
const app = express();
app.get("/", (req, res) => res.send("Bot is running!"));
app.listen(process.env.PORT || 3000, () => console.log("Web server running on port 3000"));

// SQLite Database Setup for Chat Memory
const db = new sqlite3.Database("./chat_memory.db", (err) => {
    if (err) {
        console.error("Database Error:", err);
    } else {
        db.run("CREATE TABLE IF NOT EXISTS messages (user TEXT, message TEXT)");
    }
});

// Gen Z Slang List
const slangList = ["fr", "kk", "skibidi", "rizz", "gyat", "cap", "based", "bet", "vibe", "drip", "bruh", "sus", "simp", "yeet", "bussin", "no cap", "mid", "fax", "pov", "moots", "ratio", "yap", "goofy", "smh", "idk", "lmao", "goated", "fyp", "cringe", "edgelord", "stan", "deadass", "woke", "hella", "lit", "chad", "sigma", "brokie", "boomer", "npc", "touch grass", "irl", "w", "l", "nah", "sus af", "crying fr", "i can’t 💀"];

let chatting = false;

// Register Slash Commands
const commands = [
    new SlashCommandBuilder().setName('start').setDescription('Start chat mode'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop chat mode')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
async function registerCommands() {
    try {
        console.log('Registering slash commands...');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('Slash commands registered!');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
}
registerCommands();

// Slash Command Handling
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    if (interaction.commandName === "start") {
        chatting = true;
        interaction.reply("aight bet, i'm awake now 🥶");
    } else if (interaction.commandName === "stop") {
        chatting = false;
        interaction.reply("bruh i’m out, cya 😴");
    }
});

// Message Handling with AI Integration (ChatGPT)
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const content = message.content.toLowerCase();
    const emojis = message.guild.emojis.cache;

    // Log Message to Memory (SQLite)
    db.run("INSERT INTO messages (user, message) VALUES (?, ?)", [message.author.username, content]);

    // 30% chance to reply to "Noobhay"
    if (content.includes("noobhay") && Math.random() < 0.3) {
        return message.reply("bro stop talking abt me 💀");
    }

    // 50% chance to skip message naturally
    if (Math.random() < 0.5) return;

    try {
        // Get Chat History from Database (last 10 messages)
        db.all("SELECT user, message FROM messages ORDER BY ROWID DESC LIMIT 10", async (err, rows) => {
            if (err) return console.error("Database Error:", err);

            const historyMessages = rows.map(row => ({ role: "user", content: `${row.user}: ${row.message}` }));

            // AI Chat Response
            const response = await axios.post("https://api.openai.com/v1/chat/completions", {
                model: "gpt-3.5-turbo",
                messages: [
                    { role: "system", content: "Act like a Gen Z teenager with chaotic energy." },
                    ...historyMessages,
                    { role: "user", content: content }
                ],
                max_tokens: 50,
                temperature: 0.8
            }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" } });

            let replyText = response.data.choices[0].message.content;

            // Add Random Slang
            if (Math.random() < 0.7) {
                const randomSlang = slangList[Math.floor(Math.random() * slangList.length)];
                replyText += ` ${randomSlang}`;
            }

            // React with Custom Emoji
            if (Math.random() < 0.6 && emojis.size > 0) {
                const emojiArray = Array.from(emojis.values());
                const randomEmoji = emojiArray[Math.floor(Math.random() * emojiArray.length)];
                message.react(randomEmoji);
            }

            message.reply(replyText);

            // Decide if Meme/GIF is Needed (40% chance)
            if (Math.random() < 0.4) {
                const memeOrGif = Math.random();
                if (memeOrGif < 0.5) {
                    const meme = await fetchMeme();
                    if (meme) message.channel.send({ files: [meme] });
                } else {
                    const gif = await fetchGif(content);
                    if (gif) message.channel.send(gif);
                }
            }
        });
    } catch (err) {
        console.error("OpenAI API Error:", err);
    }
});

// Fetch Meme from Reddit
async function fetchMeme() {
    try {
        const res = await axios.get(REDDIT_MEME_API);
        const memes = res.data.data.children.map(post => post.data.url);
        return memes[Math.floor(Math.random() * memes.length)];
    } catch (err) {
        console.error("Reddit API Error:", err);
        return null;
    }
}

// Fetch GIF from Tenor
async function fetchGif(query) {
    try {
        const res = await axios.get(`https://g.tenor.com/v1/search?q=${encodeURIComponent(query)}&key=${TENOR_API_KEY}&limit=10`);
        const gifs = res.data.results.map(gif => gif.media[0].gif.url);
        return gifs.length ? gifs[Math.floor(Math.random() * gifs.length)] : null;
    } catch (err) {
        console.error("Tenor API Error:", err);
        return null;
    }
}

// Login the bot
client.login(BOT_TOKEN);
