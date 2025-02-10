require('dotenv').config();
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
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Channel]
});

// 🌟 Express Web Server to Keep Render Alive
const app = express();
app.get("/", (req, res) => res.send("Bot is running!"));
app.listen(3000, () => console.log("Web server running on port 3000"));

// 🌟 SQLite Database for Memory
const db = new sqlite3.Database("./chat_memory.db", (err) => {
    if (err) console.error("Database Error:", err);
    else db.run("CREATE TABLE IF NOT EXISTS messages (user TEXT, message TEXT)");
});

// 🌟 Slash Commands
const commands = [
    new SlashCommandBuilder().setName('start').setDescription('Start the chat mode'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop the chat mode')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
(async () => {
    try {
        console.log('Registering slash commands...');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('Slash commands registered successfully!');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
})();

let chatting = false;
let messageCount = 0;

// 🌟 Command Handling
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    if (interaction.commandName === "start") {
        chatting = true;
        interaction.reply("yo i'm up, let's go 😎");
    } else if (interaction.commandName === "stop") {
        chatting = false;
        interaction.reply("ight i'm out, peace ✌️");
    }
});

// 🌟 Message Handling
client.on('messageCreate', async message => {
    if (message.author.bot || !chatting) return;

    const content = message.content.toLowerCase();
    const emojis = message.guild.emojis.cache;
    messageCount++;

    // 🔹 "Noobhay" Logic (30% chance to reply)
    if (content.includes("noobhay") && Math.random() < 0.3) {
        return message.reply("bruh wdym 💀");
    }

    // 🔹 Save Message to SQLite (Memory)
    db.run("INSERT INTO messages (user, message) VALUES (?, ?)", [message.author.username, content]);

    // 🔹 React with Custom Emojis
    if (Math.random() < 0.5 && emojis.size > 0) {
        const emojiArray = Array.from(emojis.values());
        message.react(emojiArray[Math.floor(Math.random() * emojiArray.length)]);
    }

    // 🔹 Analyze Chat Context with OpenAI
    if (messageCount >= 2 + Math.floor(Math.random() * 2)) {  // Replies after 2-3 messages
        messageCount = 0;
        try {
            const chatHistory = await new Promise((resolve, reject) => {
                db.all("SELECT user, message FROM messages ORDER BY ROWID DESC LIMIT 10", (err, rows) => {
                    if (err) reject(err);
                    resolve(rows.map(row => `${row.user}: ${row.message}`));
                });
            });

            const response = await axios.post("https://api.openai.com/v1/chat/completions", {
                model: "gpt-3.5-turbo",
                messages: [
                    { role: "system", content: "Act like a chaotic Gen Z teenager in a Discord chat. Use Gen Z slang." },
                    ...chatHistory.map(msg => ({ role: "user", content: msg })),
                    { role: "user", content: content }
                ],
                max_tokens: 50,
                temperature: 0.8
            }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" } });

            let reply = response.data.choices[0].message.content;
            message.reply(reply);

            // 🔹 Meme Upload Logic (Based on AI Chat Analysis)
            if (await shouldPostMeme(chatHistory, content)) {
                const meme = await fetchMeme();
                if (meme) message.channel.send({ files: [meme] });
            }

        } catch (err) {
            console.error("OpenAI API Error:", err);
        }
    }
});

// 🌟 Fetch Memes from Reddit
async function fetchMeme() {
    try {
        const res = await axios.get(REDDIT_MEME_API);
        const memes = res.data.data.children.map(post => post.data.url);
        return memes.length ? memes[Math.floor(Math.random() * memes.length)] : null;
    } catch (err) {
        console.error("Reddit API Error:", err);
        return null;
    }
}

// 🌟 Should Post Meme? AI Decision
async function shouldPostMeme(chatHistory, latestMessage) {
    try {
        const response = await axios.post("https://api.openai.com/v1/chat/completions", {
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: "Analyze the chat and decide if a meme should be posted." },
                ...chatHistory.map(msg => ({ role: "user", content: msg })),
                { role: "user", content: latestMessage },
                { role: "assistant", content: "Should I post a meme? Reply 'yes' or 'no'." }
            ],
            max_tokens: 10,
            temperature: 0.5
        }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" } });

        return response.data.choices[0].message.content.toLowerCase().includes("yes");
    } catch (err) {
        console.error("OpenAI API Error:", err);
        return false;
    }
}

client.login(BOT_TOKEN);
