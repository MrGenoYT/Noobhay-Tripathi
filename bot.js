const { Client, GatewayIntentBits, Partials } = require('discord.js');
const axios = require('axios');
const fs = require('fs');

const BOT_TOKEN = "MTMzODQ1NDE2MzY5NjI1NTAxNw.G63eZV.OzvhTJYMUSxVj0cpIvYvVzQ065r0G4rn_44gdU";  // Replace with your Discord bot token
const OPENAI_API_KEY = "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";  // Replace with your OpenAI API key
const TTS_API = "https://api.tts.com/generate";  // Replace with a real public TTS API
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

let chatting = false;
let voiceConnection = null;

// Gen Z slang list
const slangList = ["fr", "kk", "skibidi", "rizz", "gyat", "cap", "based", "bet", "vibe", "drip", "bruh", "sus", "cheugy", "simp", "yeet", "bussin", "no cap", "mid", "fax", "pov", "moots", "ratio", "yap", "goofy", "smh", "idk", "lmao", "goated", "fyp", "sksksk", "cringe", "edgelord", "stan", "deadass", "woke", "hella", "lit", "chad", "sigma", "brokie", "based", "boomer", "npc", "touch grass", "irl", "w", "l", "nah", "sus af", "drip", "crying fr", "i can’t 💀"];

let chatMemory = [];

// 🔹 Handle Bot Commands
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    const { commandName, member } = interaction;

    if (commandName === "start") {
        chatting = true;
        interaction.reply("aight bet, i'm awake now 🥶");
    } 
    else if (commandName === "stop") {
        chatting = false;
        interaction.reply("bruh i’m out, cya 😴");
    }
    else if (commandName === "join") {
        if (member.voice.channel) {
            voiceConnection = await member.voice.channel.join();
            interaction.reply("ight, i'm in the vc now 😎");
        } else {
            interaction.reply("bro, join a vc first 💀");
        }
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

    // 🔸 React with Custom Emojis
    if (Math.random() < 0.5) {
        const randomEmoji = emojis.random();
        if (randomEmoji) message.react(randomEmoji);
    }

    // 🔸 Add Message to Memory
    chatMemory.push(content);
    if (chatMemory.length > 10) chatMemory.shift();  // Keep recent 10 messages

    // 🔸 Randomly Skip Messages for Natural Flow
    if (Math.random() < 0.4) return;

    // 🔸 Generate Chat Response using OpenAI API
    try {
        const response = await axios.post("https://api.openai.com/v1/chat/completions", {
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: "Act like a Gen Z teenager with chaotic energy." },
                { role: "user", content: content },
                { role: "assistant", content: chatMemory.join("\n") }
            ],
            max_tokens: 50,
            temperature: 0.8
        }, { headers: { Authorization: `Bearer ${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}`, "Content-Type": "application/json" } });

        let reply = response.data.choices[0].message.content;

        // 🔸 Add Random Slang
        if (Math.random() < 0.7) {
            const randomSlang = slangList[Math.floor(Math.random() * slangList.length)];
            reply += ` ${randomSlang}`;
        }

        // 🔸 Add Custom Emoji
        if (Math.random() < 0.5) {
            reply += ` ${emojis.random()}`;
        }

        message.reply(reply);
    } catch (err) {
        console.error("ChatGPT API Error:", err);
    }
});

// 🔹 Voice Chat TTS
client.on('voiceStateUpdate', async (oldState, newState) => {
    if (!newState.channelId || newState.member.user.bot) return;

    if (voiceConnection) {
        try {
            const ttsResponse = await axios.post(TTS_API, { text: `ayo, ${newState.member.user.username} joined. wassup bro?`, lang: "en" });
            voiceConnection.play(ttsResponse.data.audio);
        } catch (err) {
            console.error("TTS API Error:", err);
        }
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

client.login(MTMzODQ1NDE2MzY5NjI1NTAxNw.G63eZV.OzvhTJYMUSxVj0cpIvYvVzQ065r0G4rn_44gdU);