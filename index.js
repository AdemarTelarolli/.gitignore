require("dotenv").config();

const express = require("express");
const fetch = require("node-fetch"); // node-fetch v2 (CommonJS)
const Database = require("better-sqlite3");

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
} = require("discord.js");

// ====== ENV ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

const BASE_GUILD_ID = process.env.BASE_GUILD_ID;
const VERIFIED_ROLE_ID = process.env.VERIFIED_ROLE_ID || "1475545732802023494";
const OWNER_ID = process.env.OWNER_ID;

// Produção (Render): EXTERNAL_URL=https://ckverify.onrender.com
function getExternalBaseUrl() {
  return process.env.EXTERNAL_URL || "http://localhost:3000";
}
function getRedirectUri() {
  return `${getExternalBaseUrl()}/oauth/callback`;
}
function buildAuthorizeUrl() {
  const u = new URL("https://discord.com/oauth2/authorize");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", getRedirectUri());
  u.searchParams.set("scope", "identify guilds.join");
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

// Link “Voltar para o Discord”
function discordBackLink() {
  const g = process.env.DISCORD_GUILD_ID || BASE_GUILD_ID;
  const c = process.env.DISCORD_CHANNEL_ID;
  if (g && c) return `https://discord.com/channels/${g}/${c}`;
  return "https://discord.com/app";
}

// ====== HTML (página bonita de sucesso) ======
function pageHtmlSuccess({ avatarUrl }) {
  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Verificado</title>
<style>
  :root{
    --bg:#0b0f19;
    --card:#2b2f36;
    --border:#3a404a;
    --text:#ffffff;
    --muted:rgba(255,255,255,.75);
    --success:#22c55e;
    --btn:#5865F2;
  }
  body{
    margin:0;
    font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;
    background:var(--bg);
    min-height:100vh;
    display:flex;
    align-items:center;
    justify-content:center;
    color:var(--text);
  }
  .card{
    width:min(560px,92vw);
    background:var(--card);
    border:1px solid var(--border);
    border-radius:22px;
    padding:28px 20px 22px;
    text-align:center;
    box-shadow:0 20px 60px rgba(0,0,0,.45);
  }
  .avatarWrap{
    width:110px;
    height:110px;
    margin:-70px auto 14px;
    background:var(--bg);
    border-radius:999px;
    display:flex;
    align-items:center;
    justify-content:center;
    border:1px solid rgba(255,255,255,.10);
  }
  .avatar{
    width:96px;
    height:96px;
    border-radius:999px;
    object-fit:cover;
    border:4px solid rgba(255,255,255,.14);
    background:#111;
  }
  .title{
    font-size:34px;
    font-weight:900;
    letter-spacing:.8px;
    color:var(--success);
    margin:0 0 10px;
  }
  .subtitle{
    margin:0;
    color:var(--muted);
    font-size:14px;
    line-height:1.4;
  }
  .btn{
    display:inline-block;
    margin-top:18px;
    padding:12px 16px;
    border-radius:14px;
    background:var(--btn);
    color:#fff;
    text-decoration:none;
    font-weight:800;
  }
  .small{
    margin-top:12px;
    font-size:12px;
    color:rgba(255,255,255,.55);
  }
</style>
</head>
<body>
  <div class="card">
    <div class="avatarWrap">
      <img class="avatar" src="${avatarUrl}" alt="Avatar"/>
    </div>

    <h1 class="title">SUCESSO</h1>
    <p class="subtitle">Sua verificação foi realizada com sucesso! Pode voltar para o Discord.</p>

    <a class="btn" href="${discordBackLink()}">Voltar para o Discord</a>
    <div class="small">Você pode fechar esta aba.</div>
  </div>
</body>
</html>`;
}

// ====== DB ======
const db = new Database("data.sqlite");
db.exec(`
CREATE TABLE IF NOT EXISTS verified_users (
  user_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER,
  verified_at INTEGER NOT NULL
);
`);

function upsertUser(u) {
  db.prepare(`
    INSERT INTO verified_users (user_id, access_token, refresh_token, expires_at, verified_at)
    VALUES (@user_id, @access_token, @refresh_token, @expires_at, @verified_at)
    ON CONFLICT(user_id) DO UPDATE SET
      access_token=excluded.access_token,
      refresh_token=excluded.refresh_token,
      expires_at=excluded.expires_at,
      verified_at=excluded.verified_at
  `).run(u);
}

function allUsers() {
  return db.prepare(`SELECT * FROM verified_users`).all();
}

// ====== BOT ======
const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences, // precisa habilitar no portal [web:171]
  ],
});

function ownerOnly(interaction) {
  if (OWNER_ID && interaction.user.id !== OWNER_ID) return true;
  return false;
}

async function registerCommands() {
  const setup = new SlashCommandBuilder()
    .setName("setupverificar")
    .setDescription("Envia a mensagem (embed) com botão de verificação (link) neste canal")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

  const estatisticas = new SlashCommandBuilder()
    .setName("estatisticas")
    .setDescription("Mostra quantos verificados existem e seus status")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

  const migrar = new SlashCommandBuilder()
    .setName("migrar")
    .setDescription("Migra verificados para um servidor por status e quantidade")
    .addStringOption((o) =>
      o.setName("servidor_id").setDescription("ID do servidor destino").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("status")
        .setDescription("Quem migrar")
        .setRequired(true)
        .addChoices(
          { name: "TODOS", value: "TODOS" },
          { name: "ONLINE", value: "ONLINE" },
          { name: "AUSENTE", value: "AUSENTE" },
          { name: "OCUPADO", value: "OCUPADO" },
          { name: "OFFLINE", value: "OFFLINE" }
        )
    )
    .addIntegerOption((o) =>
      o.setName("quantidade")
        .setDescription("Quantidade máxima")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(1000)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), {
    body: [setup.toJSON(), migrar.toJSON(), estatisticas.toJSON()],
  });
}

async function addMemberToGuild(targetGuildId, userId, userAccessToken) {
  const url = `https://discord.com/api/v10/guilds/${targetGuildId}/members/${userId}`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ access_token: userAccessToken }),
  });
  return r.status; // 201 created, 204 already member [web:17]
}

function normalizePickToPresence(statusPick) {
  // PresenceStatus: online | idle | dnd | offline [web:309]
  if (statusPick === "ONLINE") return "online";
  if (statusPick === "AUSENTE") return "idle";
  if (statusPick === "OCUPADO") return "dnd";
  if (statusPick === "OFFLINE") return "offline";
  return null;
}

bot.on("ready", async () => {
  await registerCommands();
  console.log("Bot logado como:", bot.user.tag);
  console.log("EXTERNAL_URL:", process.env.EXTERNAL_URL);
  console.log("Redirect URI:", getRedirectUri());
  console.log("Authorize URL:", buildAuthorizeUrl());
});

bot.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    // Dono-only para /migrar e /estatisticas
    if ((interaction.commandName === "migrar" || interaction.commandName === "estatisticas") && ownerOnly(interaction)) {
      return interaction.reply({ content: "Sem permissão.", ephemeral: true });
    }

    // /setupverificar pode ficar para admins (e opcionalmente dono-only)
    if (interaction.commandName === "setupverificar") {
      const embed = new EmbedBuilder()
        .setColor(0x22C55E)
        .setTitle("Verificação de Conta")
        .setDescription(
          [
            "Para concluir sua verificação, clique no botão abaixo e autorize o acesso solicitado.",
            "",
            "**Após autorizar:**",
            "• Você receberá o cargo de verificado automaticamente.",
            "• Seu acesso ficará liberado para migração quando o dono usar `/migrar`.",
            "",
            "_Se o cargo não aparecer em até 1 minuto, tente novamente ou contate um administrador._",
          ].join("\n")
        )
        .setFooter({ text: "Sistema de verificação • ckverify" });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("Verificar-se")
          .setStyle(ButtonStyle.Link)
          .setURL(buildAuthorizeUrl())
      );

      await interaction.channel.send({
        embeds: [embed],
        components: [row],
      });

      return interaction.reply({ content: "Mensagem de verificação enviada.", ephemeral: true });
    }

    if (interaction.commandName === "estatisticas") {
      await interaction.reply({ content: "Calculando...", ephemeral: true });

      const verified = allUsers();
      const verifiedIds = new Set(verified.map((v) => v.user_id));

      const guild = await bot.guilds.fetch(BASE_GUILD_ID);
      const members = await guild.members.fetch({ withPresences: true });

      let online = 0, idle = 0, dnd = 0, offline = 0;

      for (const [id, member] of members) {
        if (!verifiedIds.has(id)) continue;

        const st = member.presence?.status ?? "offline";
        if (st === "online") online++;
        else if (st === "idle") idle++;
        else if (st === "dnd") dnd++;
        else offline++;
      }

      const embed = new EmbedBuilder()
        .setColor(0x22C55E)
        .setTitle("Estatísticas de Verificação")
        .setDescription(
          [
            `**Total verificados:** ${verified.length}`,
            "",
            `🟢 **Online:** ${online}`,
            `🟡 **Ausentes:** ${idle}`,
            `🔴 **Ocupados:** ${dnd}`,
            `⚫ **Offlines:** ${offline}`,
          ].join("\n")
        )
        .setFooter({ text: "Dados do servidor base" });

      return interaction.editReply({ content: "", embeds: [embed] });
    }

    if (interaction.commandName === "migrar") {
      const targetGuildId = interaction.options.getString("servidor_id", true);
      const statusPick = interaction.options.getString("status", true); // TODOS/ONLINE/AUSENTE/OCUPADO/OFFLINE
      const limit = interaction.options.getInteger("quantidade", true);

      await interaction.reply({ content: "Preparando lista...", ephemeral: true });

      const verified = allUsers();
      const guild = await bot.guilds.fetch(BASE_GUILD_ID);
      const members = await guild.members.fetch({ withPresences: true });

      const targetPresence = normalizePickToPresence(statusPick);

      const selected = [];
      for (const u of verified) {
        const member = members.get(u.user_id);
        const st = member?.presence?.status ?? "offline"; // [web:309]

        if (statusPick !== "TODOS" && st !== targetPresence) continue;

        selected.push(u);
        if (selected.length >= limit) break;
      }

      await interaction.editReply({
        content: `Migrando ${selected.length} usuários (${statusPick})...`,
        ephemeral: true,
      });

      let ok = 0, already = 0, fail = 0;
      for (const u of selected) {
        const code = await addMemberToGuild(targetGuildId, u.user_id, u.access_token).catch(() => 0);
        if (code === 201) ok++;
        else if (code === 204) already++;
        else fail++;
      }

      return interaction.followUp({
        content: `Finalizado. Entraram: ${ok}, já estavam: ${already}, falharam: ${fail}.`,
        ephemeral: true,
      });
    }
  } catch (e) {
    if (interaction.isRepliable()) {
      return interaction.reply({ content: `Erro: ${String(e.message || e)}`, ephemeral: true }).catch(() => {});
    }
  }
});

bot.login(BOT_TOKEN);

// ====== WEB ======
const app = express();
const PORT = process.env.PORT || 3000;

async function exchangeCodeForToken(code) {
  const params = new URLSearchParams();
  params.append("client_id", CLIENT_ID);
  params.append("client_secret", CLIENT_SECRET);
  params.append("grant_type", "authorization_code");
  params.append("code", code);
  params.append("redirect_uri", getRedirectUri());

  const r = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  if (!r.ok) throw new Error(`token_exchange_failed_${r.status}`);
  return r.json(); // OAuth2 token [web:2]
}

async function getMe(accessToken) {
  const r = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`get_me_failed_${r.status}`);
  return r.json(); // user [web:249]
}

app.get("/", (req, res) => res.status(200).send("OK"));

app.get("/oauth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) {
      return res
        .status(400)
        .send(pageHtmlSuccess({ avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png" }));
    }

    const token = await exchangeCodeForToken(code);
    const me = await getMe(token.access_token);

    const avatarUrl = me.avatar
      ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=256`
      : `https://cdn.discordapp.com/embed/avatars/${Number(me.id) % 5}.png`;

    upsertUser({
      user_id: me.id,
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      expires_at: Date.now() + token.expires_in * 1000,
      verified_at: Date.now(),
    });

    try {
      const guild = await bot.guilds.fetch(BASE_GUILD_ID);
      const member = await guild.members.fetch(me.id);
      await member.roles.add(VERIFIED_ROLE_ID);
    } catch (e) {}

    return res.status(200).send(pageHtmlSuccess({ avatarUrl }));
  } catch (e) {
    return res
      .status(500)
      .send(pageHtmlSuccess({ avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png" }));
  }
});

app.listen(PORT, () => console.log("Web on", PORT));
