const { Client, GatewayIntentBits, Partials } = require('discord.js');
const axios = require('axios');
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REDDIT_MEME_API = "https://www.reddit.com/r/memes/top.json?limit=50&t=day";

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Channel]
});

// Load or create chat memory file
const MEMORY_FILE = "memory.json";
let chatMemory = [];
if (fs.existsSync(MEMORY_FILE)) {
    chatMemory = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
}

let chatting = false;

// Gen Z slang list
const slangList = ["fr", "kk", "skibidi", "rizz", "gyat", "cap", "based", "bet", "vibe", "drip", "bruh", "sus", "cheugy", "simp", "yeet", "bussin", "no cap", "mid", "fax", "pov", "moots", "ratio", "yap", "goofy", "smh", "idk", "lmao", "goated", "fyp", "sksksk", "cringe", "edgelord", "stan", "deadass", "woke", "hella", "lit", "chad", "sigma", "brokie", "boomer", "npc", "touch grass", "irl", "w", "l", "nah", "sus af", "drip", "crying fr", "i can’t 💀"];

// 🔹 Handle Bot Commands
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    const { commandName } = interaction;

    if (commandName === "start") {
        chatting = true;
        interaction.reply("aight bet, i'm awake now 🥶");
    } 
    else if (commandName === "stop") {
        chatting = false;
        interaction.reply("bruh i’m out, cya 😴");
    }
});

// 🔹 Chat Response System
client.on('messageCreate', async message => {
    if (message.author.bot || !chatting) return;

    const content = message.content.toLowerCase();
    const emojis = message.guild.emojis.cache;
    
    // 🔸 Handle Personal Questions
    if (content.includes("your age") || content.includes("how old are you") || content.includes("where are you from")) {
        return message.reply("nuh uh");
    }

    // 🔸 React with Custom Emojis (Fixed Version)
    if (Math.random() < 0.5) {
        const emojiArray = Array.from(emojis.values());  
        const randomEmoji = emojiArray.length ? emojiArray[Math.floor(Math.random() * emojiArray.length)] : null;  
        if (randomEmoji) message.react(randomEmoji);
    }

    // 🔸 Save Message to Memory (Forever)
    chatMemory.push({ user: message.author.username, message: content });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(chatMemory, null, 2));

    // 🔸 Randomly Skip Messages for Natural Flow
    if (Math.random() < 0.4) return;

    // 🔸 Generate Chat Response using OpenAI API
    try {
        const response = await axios.post("https://api.openai.com/v1/chat/completions", {
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: "Act like a Gen Z teenager with chaotic energy." },
                { role: "user", content: content },
                { role: "assistant", content: chatMemory.slice(-10).map(msg => `${msg.user}: ${msg.message}`).join("\n") }
            ],
            max_tokens: 50,
            temperature: 0.8
        }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" } });

        let reply = response.data.choices[0].message.content;

        // 🔸 Add Random Slang
        if (Math.random() < 0.7) {
            const randomSlang = slangList[Math.floor(Math.random() * slangList.length)];
            reply += ` ${randomSlang}`;
        }

        // 🔸 Add Custom Emoji
        if (Math.random() < 0.5) {
            const emojiArray = Array.from(emojis.values());  
            const randomEmoji = emojiArray.length ? emojiArray[Math.floor(Math.random() * emojiArray.length)] : null;  
            if (randomEmoji) reply += ` ${randomEmoji}`;
        }

        message.reply(reply);
    } catch (err) {
        console.error("ChatGPT API Error:", err);
    }
});

// 🔹 Fetch Memes from Reddit
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

// 🔹 Meme & GIF Uploads (Relevant to Chat)
setInterval(async () => {
    if (!chatting) return;

    const meme = await fetchMeme();
    const activeChannels = client.channels.cache.filter(ch => ch.type === 0 && ch.messages.cache.size > 5);
    const randomChannel = activeChannels.random();

    if (randomChannel && meme) randomChannel.send({ files: [meme] });
}, 60000 * 10);  // Posts a meme every 10 minutes

client.login(BOT_TOKEN);