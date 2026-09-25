#!/usr/bin/env node
// Builds the profile cards straight from the GitHub GraphQL API — no third-party card services.
// Writes assets/cards/{stats,years}-{dark,light}.svg. On any API failure it exits non-zero
// before touching disk, so the last good cards stay in place.
// Everything here comes from the contribution calendar, which includes private work as bare
// counts (profile setting "Include private contributions"), so any token works — no org access needed.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOGIN = process.env.PROFILE_LOGIN ?? "avetisyan66";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "cards");

const THEMES = {
  dark: {
    surface: "#1C0F16",
    stroke: "#3A1F2B",
    ink: "#F6E7EC",
    muted: "#B89AA6",
    faint: "#6E5260",
    seed: "#F0476B",
    apricot: "#F2994A",
  },
  light: {
    surface: "#FFFBF8",
    stroke: "#F1D9CF",
    ink: "#2B1119",
    muted: "#7D5B66",
    faint: "#C9AEB6",
    seed: "#C8264A",
    apricot: "#D9772B",
  },
};

const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const MAX_ATTEMPTS = 4;

async function postWithRetry(body, attempt = 1) {
  try {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status >= 500 && attempt < MAX_ATTEMPTS) throw new Error(`GitHub API ${response.status}`);
    return response;
  } catch (error) {
    if (attempt >= MAX_ATTEMPTS) throw error;
    await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    return postWithRetry(body, attempt + 1);
  }
}

async function graphql(query, variables = {}) {
  const response = await postWithRetry(JSON.stringify({ query, variables }));
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  const { data, errors } = await response.json();
  if (errors?.length) throw new Error(errors.map((error) => error.message).join("; "));
  return data;
}

async function fetchProfile() {
  const { user } = await graphql(
    `query ($login: String!) {
      user(login: $login) {
        createdAt
      }
    }`,
    { login: LOGIN },
  );
  return user;
}

async function fetchYear(year, until) {
  const { user } = await graphql(
    `query ($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            totalContributions
            weeks { contributionDays { date contributionCount } }
          }
        }
      }
    }`,
    {
      login: LOGIN,
      from: `${year}-01-01T00:00:00Z`,
      to: year === until.getUTCFullYear() ? until.toISOString() : `${year}-12-31T23:59:59Z`,
    },
  );
  const collection = user.contributionsCollection;
  return {
    year,
    contributions: collection.contributionCalendar.totalContributions,
    days: collection.contributionCalendar.weeks.flatMap((week) => week.contributionDays),
  };
}

function computeStreaks(days) {
  const today = new Date().toISOString().slice(0, 10);
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  let longest = 0;
  let running = 0;
  for (const day of sorted) {
    running = day.contributionCount > 0 ? running + 1 : 0;
    longest = Math.max(longest, running);
  }
  // Today not being done yet shouldn't break the current streak.
  const settled = sorted.at(-1)?.date === today && sorted.at(-1).contributionCount === 0 ? sorted.slice(0, -1) : sorted;
  let current = 0;
  for (let index = settled.length - 1; index >= 0 && settled[index].contributionCount > 0; index -= 1) current += 1;
  return { current, longest };
}

async function collectStats() {
  const now = new Date();
  const profile = await fetchProfile();
  const joined = new Date(profile.createdAt);
  const years = [];
  for (let year = joined.getUTCFullYear(); year <= now.getUTCFullYear(); year += 1) {
    years.push(await fetchYear(year, now));
  }
  const days = years.flatMap((year) => year.days);
  const bestYear = years.reduce((best, year) => (year.contributions > best.contributions ? year : best));
  return {
    joined,
    years,
    contributions: years.reduce((total, year) => total + year.contributions, 0),
    bestYear,
    busiestDay: Math.max(...days.map((day) => day.contributionCount)),
    activeDays: days.filter((day) => day.contributionCount > 0).length,
    streaks: computeStreaks(days),
  };
}

const formatNumber = (value) => value.toLocaleString("en-US");
const escapeXml = (value) => String(value).replace(/[<>&"]/g, (char) => `&#${char.charCodeAt(0)};`);

function frame({ width, height, theme, title, subtitle, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
  <title>${escapeXml(title)}</title>
  <style>
    .fade { opacity: 0; animation: fade 0.6s ease-out forwards; }
    @keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @keyframes grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
    @media (prefers-reduced-motion: reduce) { .fade, .bar { animation: none !important; opacity: 1 !important; } }
  </style>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="16" fill="${theme.surface}" stroke="${theme.stroke}"/>
  <text x="28" y="40" font-family="${MONO}" font-size="15" font-weight="700" fill="${theme.seed}">${escapeXml(title)}</text>
  <text x="${width - 28}" y="40" text-anchor="end" font-family="${MONO}" font-size="12" fill="${theme.muted}">${escapeXml(subtitle)}</text>
${body}
</svg>
`;
}

function renderStats(stats, theme) {
  const width = 840;
  const height = 230;
  const tiles = [
    { label: "active days", value: stats.activeDays },
    { label: "longest streak", value: stats.streaks.longest, unit: "days" },
    { label: "current streak", value: stats.streaks.current, unit: "days" },
    { label: "per active day", value: Math.round((stats.contributions / Math.max(stats.activeDays, 1)) * 10) / 10 },
    { label: `best year (${stats.bestYear.year})`, value: stats.bestYear.contributions },
    { label: "busiest day", value: stats.busiestDay },
  ];
  const columns = 3;
  const tileWidth = 164;
  const tileHeight = 64;
  const gridX = 300;

  const hero = `
  <g class="fade">
    <text x="28" y="118" font-family="${FONT}" font-size="56" font-weight="800" fill="${theme.ink}">${formatNumber(stats.contributions)}</text>
    <text x="30" y="146" font-family="${MONO}" font-size="13" fill="${theme.muted}">lifetime contributions</text>
    <text x="30" y="166" font-family="${MONO}" font-size="12" fill="${theme.faint}">public + private · since ${stats.joined.getUTCFullYear()}</text>
    <circle cx="36" cy="196" r="5" fill="${theme.seed}"/>
    <circle cx="52" cy="196" r="5" fill="${theme.apricot}"/>
    <text x="66" y="200" font-family="${MONO}" font-size="12" fill="${theme.muted}">shipping from Yerevan</text>
  </g>`;

  const grid = tiles
    .map((tile, index) => {
      const x = gridX + (index % columns) * (tileWidth + 12);
      const y = 64 + Math.floor(index / columns) * (tileHeight + 12);
      const accent = index < 2 ? theme.seed : theme.apricot;
      return `
  <g class="fade" style="animation-delay:${0.15 + index * 0.08}s">
    <rect x="${x}" y="${y}" width="${tileWidth}" height="${tileHeight}" rx="10" fill="none" stroke="${theme.stroke}"/>
    <rect x="${x}" y="${y + 14}" width="3" height="${tileHeight - 28}" rx="1.5" fill="${accent}"/>
    <text x="${x + 16}" y="${y + 32}" font-family="${FONT}" font-size="22" font-weight="700" fill="${theme.ink}">${formatNumber(tile.value)}${tile.unit ? `<tspan font-size="12" font-weight="400" fill="${theme.muted}"> ${tile.unit}</tspan>` : ""}</text>
    <text x="${x + 16}" y="${y + 50}" font-family="${MONO}" font-size="12" fill="${theme.muted}">${tile.label}</text>
  </g>`;
    })
    .join("");

  return frame({
    width,
    height,
    theme,
    title: "~/lifetime-on-github",
    subtitle: `updated ${new Date().toISOString().slice(0, 10)}`,
    body: hero + grid,
  });
}

function renderYears(stats, theme) {
  const width = 840;
  const height = 250;
  const plot = { left: 28, right: width - 28, top: 76, bottom: 206 };
  const peak = Math.max(...stats.years.map((year) => year.contributions), 1);
  const slot = (plot.right - plot.left) / stats.years.length;
  const barWidth = Math.min(64, slot * 0.5);
  const currentYear = new Date().getUTCFullYear();

  const bars = stats.years
    .map((year, index) => {
      const barHeight = Math.max(4, ((plot.bottom - plot.top) * year.contributions) / peak);
      const x = plot.left + slot * index + (slot - barWidth) / 2;
      const y = plot.bottom - barHeight;
      const center = x + barWidth / 2;
      const fill = year.year === currentYear ? theme.apricot : theme.seed;
      return `
  <g>
    <title>${year.year}: ${formatNumber(year.contributions)} contributions</title>
    <path class="bar" style="transform-origin:${center}px ${plot.bottom}px;animation:grow 0.9s cubic-bezier(.2,.8,.2,1) ${index * 0.1}s both"
      d="M${x},${plot.bottom} V${y + 4} Q${x},${y} ${x + 4},${y} H${x + barWidth - 4} Q${x + barWidth},${y} ${x + barWidth},${y + 4} V${plot.bottom} Z" fill="${fill}"/>
    <text class="fade" style="animation-delay:${0.5 + index * 0.1}s" x="${center}" y="${y - 8}" text-anchor="middle" font-family="${FONT}" font-size="13" font-weight="700" fill="${theme.ink}">${formatNumber(year.contributions)}</text>
    <text x="${center}" y="${plot.bottom + 22}" text-anchor="middle" font-family="${MONO}" font-size="12" fill="${theme.muted}">${year.year}${year.year === currentYear ? " ·ytd" : ""}</text>
  </g>`;
    })
    .join("");

  const baseline = `<line x1="${plot.left}" y1="${plot.bottom + 0.5}" x2="${plot.right}" y2="${plot.bottom + 0.5}" stroke="${theme.stroke}"/>`;

  return frame({
    width,
    height,
    theme,
    title: "~/contributions-per-year",
    subtitle: "public + private",
    body: baseline + bars,
  });
}

const INTRO_LINES = [
  [["// ani.ts — hi, glad you're here", "muted"]],
  [["const ", "seed"], ["ani", "ink"], [" = {", "muted"]],
  [["  role", "ink"], [": ", "muted"], ['"JavaScript / TypeScript engineer"', "apricot"], [",", "muted"]],
  [["  stack", "ink"], [": [", "muted"], ['"React Native"', "apricot"], [", ", "muted"], ['"React"', "apricot"], [", ", "muted"], ['"Next.js"', "apricot"], [", ", "muted"], ['"Node"', "apricot"], [", ", "muted"], ['"GraphQL"', "apricot"], ["],", "muted"]],
  [["  based", "ink"], [": ", "muted"], ['"Yerevan, Armenia"', "apricot"], [",", "muted"]],
  [["  loves", "ink"], [": ", "muted"], ['"scalable web & mobile apps"', "apricot"], [",", "muted"]],
  [["  fuel", "ink"], [": ", "muted"], ['"apricots & coffee"', "apricot"], [",", "muted"]],
  [["};", "muted"]],
];

function renderIntro(theme) {
  const width = 840;
  const lineHeight = 26;
  const charWidth = 9.05;
  const top = 78;
  const height = top + (INTRO_LINES.length - 1) * lineHeight + 30;
  const typingSpeed = 0.028;
  let startAt = 0.4;

  const lines = INTRO_LINES.map((tokens, index) => {
    const y = top + index * lineHeight;
    const length = tokens.reduce((total, [text]) => total + text.length, 0);
    const duration = Math.max(0.15, length * typingSpeed);
    const begin = startAt;
    startAt += duration + 0.12;
    const spans = tokens.map(([text, color]) => `<tspan fill="${theme[color]}">${escapeXml(text)}</tspan>`).join("");
    return `
  <clipPath id="line-${index}"><rect x="56" y="${y - 18}" height="${lineHeight}" width="0">
    <animate attributeName="width" from="0" to="${length * charWidth + 4}" begin="${begin.toFixed(2)}s" dur="${duration.toFixed(2)}s" fill="freeze" calcMode="discrete" keyTimes="${discreteKeyTimes(length)}" values="${discreteValues(length, charWidth)}"/>
  </rect></clipPath>
  <text x="28" y="${y}" font-family="${MONO}" font-size="13" fill="${theme.faint}" text-anchor="start">${String(index + 1).padStart(2, " ")}</text>
  <text x="60" y="${y}" font-family="${MONO}" font-size="15" xml:space="preserve" clip-path="url(#line-${index})">${spans}</text>`;
  }).join("");

  const lastY = top + (INTRO_LINES.length - 1) * lineHeight;
  const cursorX = 60 + INTRO_LINES.at(-1).reduce((total, [text]) => total + text.length, 0) * charWidth + 4;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Ani Avetisyan — JavaScript / TypeScript engineer from Yerevan, Armenia. React Native, React, Next.js, Node, GraphQL.">
  <title>Ani Avetisyan — JavaScript / TypeScript engineer from Yerevan, Armenia</title>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="16" fill="${theme.surface}" stroke="${theme.stroke}"/>
  <circle cx="30" cy="28" r="6" fill="${theme.seed}"/>
  <circle cx="50" cy="28" r="6" fill="${theme.apricot}"/>
  <circle cx="70" cy="28" r="6" fill="${theme.faint}"/>
  <text x="${width / 2}" y="32" text-anchor="middle" font-family="${MONO}" font-size="12" fill="${theme.muted}">~/avetisyan66/ani.ts</text>
  <line x1="0" y1="50.5" x2="${width}" y2="50.5" stroke="${theme.stroke}"/>
${lines}
  <rect x="${cursorX}" y="${lastY - 14}" width="9" height="18" rx="1" fill="${theme.seed}" opacity="0">
    <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.01;0.5;0.51" dur="1s" begin="${startAt.toFixed(2)}s" repeatCount="indefinite"/>
  </rect>
</svg>
`;
}

function discreteKeyTimes(length) {
  return Array.from({ length: length + 1 }, (_, step) => (step / length).toFixed(4)).join(";");
}

function discreteValues(length, charWidth) {
  return Array.from({ length: length + 1 }, (_, step) => (step * charWidth + (step === length ? 4 : 0)).toFixed(1)).join(";");
}

const BUTTONS = [
  { name: "portfolio", label: "avetisyan66.github.io", caption: "portfolio", fill: "#D12E53", ink: "#FFFFFF", icon: "globe" },
  { name: "linkedin", label: "in/avetisyan66", caption: "linkedin", fill: "#E88A3C", ink: "#2B1119", icon: "in" },
];

const ICONS = {
  globe: (ink) => `<g fill="none" stroke="${ink}" stroke-width="1.6"><circle cx="28" cy="24" r="9"/><ellipse cx="28" cy="24" rx="4" ry="9"/><line x1="19" y1="24" x2="37" y2="24"/></g>`,
  in: (ink) => `<rect x="19" y="15" width="18" height="18" rx="4" fill="${ink}"/><text x="28" y="29" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="800" fill="#E88A3C">in</text>`,
};

function renderButton(button) {
  const width = 236;
  const height = 48;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${button.caption}: ${button.label}">
  <rect width="${width}" height="${height}" rx="24" fill="${button.fill}"/>
  ${ICONS[button.icon](button.ink)}
  <text x="48" y="21" font-family="${MONO}" font-size="10" letter-spacing="1.5" fill="${button.ink}" opacity="0.75">${button.caption.toUpperCase()}</text>
  <text x="48" y="36" font-family="${FONT}" font-size="14" font-weight="700" fill="${button.ink}">${button.label} ↗</text>
</svg>
`;
}

async function main() {
  if (!TOKEN) throw new Error("Set GITHUB_TOKEN to query the GitHub API.");
  const stats = await collectStats();
  const cards = [
    ...Object.entries(THEMES).flatMap(([mode, theme]) => [
      [`intro-${mode}.svg`, renderIntro(theme)],
      [`stats-${mode}.svg`, renderStats(stats, theme)],
      [`years-${mode}.svg`, renderYears(stats, theme)],
    ]),
    ...BUTTONS.map((button) => [`${button.name}.svg`, renderButton(button)]),
  ];
  await mkdir(OUT_DIR, { recursive: true });
  await Promise.all(cards.map(([name, svg]) => writeFile(join(OUT_DIR, name), svg)));
  console.log(
    `contributions=${stats.contributions} active=${stats.activeDays} best=${stats.bestYear.year}:${stats.bestYear.contributions} busiest=${stats.busiestDay} streak=${stats.streaks.current}/${stats.streaks.longest}`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
