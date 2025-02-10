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
        GatewayIntentBits.MessageContent
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
const slangList = ["fr", "kk", "skibidi", "rizz", "gyat", "cap", "based", "bet", "bruh", "sus", "simp", "yeet", "bussin", "mid", "fax", "pov", "moots", "ratio", "goofy", "smh", "idk", "lmao", "goated", "fyp", "cringe", "woke", "hella", "lit", "chad", "sigma", "npc", "irl", "w", "l", "nah", "sus af", "crying fr", "💀"];

let chatting = false;

// 🌟 Slash Command Registration
const commands = [
    new SlashCommandBuilder().setName('start').setDescription('Start the chat mode'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop the chat mode'),
    new SlashCommandBuilder().setName('slang').setDescription('Get slang definitions')
        .addStringOption(option => 
            option.setName('term')
                .setDescription('Slang word to define')
                .setAutocomplete(true))
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
    if (interaction.isAutocomplete()) {
        const focusedValue = interaction.options.getFocused();
        const filtered = slangList.filter(slang => slang.startsWith(focusedValue));
        await interaction.respond(filtered.map(slang => ({ name: slang, value: slang })).slice(0, 5));
    } else if (interaction.isCommand()) {
        handleCommand(interaction.commandName, interaction);
    }
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
    } else if (command === "slang") {
        const term = interaction.options.getString('term');
        if (term) {
            reply(interaction, getSlangDefinition(term));
        } else {
            reply(interaction, "Use `/slang [word]` to get a definition.");
        }
    }
}

// 🌟 Reply Helper Function
function reply(target, text) {
    if (target.reply) target.reply(text);  // Slash command response
    else target.channel.send(text);        // Prefix command response
}

// 🌟 Get Slang Definition
function getSlangDefinition(term) {
    const definitions = {
        "fr": "For real, meaning 'seriously' or 'I agree'.",
        "kk": "Okay, cool.",
        "skibidi": "A viral internet dance/meme trend.",
        "rizz": "Short for 'charisma', means having game or charm.",
        "gyat": "A reaction to something attractive.",
        "cap": "Lie or falsehood.",
        "based": "Confidently expressing a controversial but true opinion.",
        "bet": "Agreement or confirmation.",
        "bruh": "An expression of disbelief or annoyance."
    };
    return definitions[term] || "Dawg, I don't know that one 💀";
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

            await message.reply(reply);

            // 🔸 Post Relevant Meme  
            if (Math.random() < 0.3) {  
                const meme = await fetchMeme();  
                if (meme) message.channel.send({ files: [meme] });  
            }

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

// 🌟 Bot Login
client.login(BOT_TOKEN);
