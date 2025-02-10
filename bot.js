const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } = require('discord.js');
const axios = require('axios');
const express = require('express');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REDDIT_MEME_API = "https://www.reddit.com/r/memes/top.json?limit=50&t=day";

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Channel]
});

// 🌟 Express Web Server to Keep Render Alive
const app = express();
app.get("/", (req, res) => res.send("Bot is running!"));
app.listen(3000, () => console.log("Web server running on port 3000"));

// 🌟 SQLite Database for Infinite Memory
const db = new sqlite3.Database("./chat_memory.db", (err) => {
    if (err) console.error("Database Error:", err);
    else db.run("CREATE TABLE IF NOT EXISTS messages (user TEXT, message TEXT)");
});

// 🌟 Gen Z Slang List
const slangList = ["fr", "kk", "skibidi", "rizz", "gyat", "cap", "based", "bet", "vibe", "drip", "bruh", "sus", "simp", "yeet", "bussin", "no cap", "mid", "fax", "pov", "moots", "ratio", "yap", "goofy", "smh", "idk", "lmao", "goated", "fyp", "cringe", "edgelord", "stan", "deadass", "woke", "hella", "lit", "chad", "sigma", "brokie", "boomer", "npc", "touch grass", "irl", "w", "l", "nah", "sus af", "crying fr", "i can’t 💀"];

let chatting = false;

// 🌟 Slash Command Registration
const commands = [
    new SlashCommandBuilder().setName('start').setDescription('Start the chat mode'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop the chat mode'),
    new SlashCommandBuilder().setName('join').setDescription('Join VC (currently disabled)'),
    new SlashCommandBuilder().setName('leave').setDescription('Leave VC (currently disabled)')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
async function registerCommands() {
    try {
        console.log('Registering slash commands...');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('Slash commands registered successfully!');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
}
registerCommands();

// 🌟 Slash & Prefix Command Handling
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    handleCommand(interaction.commandName, interaction);
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const content = message.content.toLowerCase();
    if (content.startsWith("!")) {
        const args = content.slice(1).split(" ");
        const command = args.shift();
        handleCommand(command, message);
    }
});

// 🌟 Command Execution Function
async function handleCommand(command, interaction) {
    if (command === "start") {
        chatting = true;
        reply(interaction, "aight bet, i'm awake now 🥶");
    } else if (command === "stop") {
        chatting = false;
        reply(interaction, "bruh i’m out, cya 😴");
    } else if (command === "join") {
        reply(interaction, "VC joining temporarily disabled to avoid intent issues.");
    } else if (command === "leave") {
        reply(interaction, "VC leaving temporarily disabled.");
    }
}

// 🌟 Reply Helper Function
function reply(target, text) {
    if (target.reply) target.reply(text);  // Slash command response
    else target.channel.send(text);        // Prefix command response
}

// 🌟 Chat Handling
client.on('messageCreate', async message => {
    if (message.author.bot || !chatting) return;

    const content = message.content.toLowerCase();
    const emojis = message.guild.emojis.cache;

    // 🔸 Handle Personal Questions
    if (content.includes("your age") || content.includes("how old are you") || content.includes("where are you from")) {
        return message.reply("nuh uh");
    }

    // 🔸 React with Custom Emojis
    if (Math.random() < 0.5) {
        const emojiArray = Array.from(emojis.values());
        if (emojiArray.length) message.react(emojiArray[Math.floor(Math.random() * emojiArray.length)]);
    }

    // 🔸 Save Message to SQLite (Infinite Memory)
    db.run("INSERT INTO messages (user, message) VALUES (?, ?)", [message.author.username, content]);

    // 🔸 Random Skip to Feel Natural
    if (Math.random() < 0.4) return;

    // 🔸 Generate AI Response
    try {
        db.all("SELECT user, message FROM messages ORDER BY ROWID DESC LIMIT 10", async (err, rows) => {
            if (err) return console.error("Database Error:", err);

            const historyMessages = rows.map(row => ({ role: "user", content: `${row.user}: ${row.message}` }));

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

            let reply = response.data.choices[0].message.content;

            // 🔸 Add Slang
            if (Math.random() < 0.7) {
                const randomSlang = slangList[Math.floor(Math.random() * slangList.length)];
                reply += ` ${randomSlang}`;
            }

            message.reply(reply);
        });
    } catch (err) {
        console.error("OpenAI API Error:", err);
    }
});

// 🌟 Fetch Memes from Reddit
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

// 🌟 Auto Meme Posting
setInterval(async () => {
    if (!chatting) return;

    const meme = await fetchMeme();
    const activeChannels = client.channels.cache.filter(ch => ch.type === 0);
    const activeChannelsArray = Array.from(activeChannels.values());
    const randomChannel = activeChannelsArray.length ? activeChannelsArray[Math.floor(Math.random() * activeChannelsArray.length)] : null;

    if (randomChannel && meme) randomChannel.send({ files: [meme] });

}, 60000 * 10);

client.login(BOT_TOKEN);
