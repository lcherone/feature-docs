#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const config = loadConfig(args);
const docsDir = path.resolve(process.cwd(), args.docs || config.docsDir || "docs");
const publishPlan = loadPublishPlan(docsDir, config);

if (config.dryRun || args.dryRun) {
  printDryRun(publishPlan);
  process.exit(0);
}

await publish(publishPlan, config);

function loadPublishPlan(rootDir, loadedConfig) {
  const indexFile = path.join(rootDir, "index.md");
  const summaryFile = path.join(rootDir, "summary.json");

  if (!existsSync(indexFile)) {
    fail(`index.md not found in ${rootDir}`);
  }

  if (!existsSync(summaryFile)) {
    fail(`summary.json not found in ${rootDir}`);
  }

  const indexMarkdown = readFileSync(indexFile, "utf8");
  const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
  const rootTitle = loadedConfig.rootTitle || args.title || firstMarkdownHeading(indexMarkdown) || path.basename(rootDir);
  const indexLinks = parseIndexPageLinks(indexMarkdown);
  const indexLinkKeys = new Set(indexLinks.keys());
  const docs = [{
    key: "index.md",
    title: rootTitle,
    file: indexFile,
    parentKey: loadedConfig.parentPageId ? "__external_parent__" : "",
  }];

  for (const page of summary.pages || []) {
    const docFile = path.join(rootDir, page.docFile);

    if (!existsSync(docFile)) {
      continue;
    }

    const relativeDocFile = normaliseRelativePath(path.relative(rootDir, docFile));
    const screenTitle = indexLinks.get(relativeDocFile) || page.indexTitle || firstMarkdownHeading(readFileSync(docFile, "utf8")) || page.title;

    docs.push({
      key: relativeDocFile,
      title: childPageTitle(rootTitle, screenTitle),
      file: docFile,
      parentKey: publishParentKey(page, relativeDocFile, indexLinkKeys),
    });
  }

  ensureUniqueTitles(docs, rootTitle);

  const titleByKey = new Map(docs.map((doc) => [doc.key, doc.title]));

  return {
    rootDir,
    rootTitle,
    docs: docs.map((doc) => ({
      ...doc,
      markdown: readFileSync(doc.file, "utf8"),
      html: "",
      attachments: [],
    })).map((doc) => {
      const converted = markdownToStorage(doc.markdown, {
        sourceFile: doc.file,
        rootDir,
        titleByKey,
      });

      return {
        ...doc,
        html: converted.html,
        attachments: converted.attachments,
      };
    }),
  };
}

function ensureUniqueTitles(docs, rootTitle) {
  const seen = new Map();

  for (const doc of docs) {
    const key = doc.title.toLowerCase();
    const count = seen.get(key) || 0;

    if (!count) {
      seen.set(key, 1);
      continue;
    }

    const suffix = pageTitleSuffix(doc.markdown || readFileSync(doc.file, "utf8")) || `Page ${count + 1}`;
    const candidate = `${rootTitle} - ${suffix}`;
    doc.title = uniqueTitle(candidate, seen);
    seen.set(key, count + 1);
  }
}

function uniqueTitle(candidate, seen) {
  let title = candidate;
  let index = 2;

  while (seen.has(title.toLowerCase())) {
    title = `${candidate} (${index})`;
    index += 1;
  }

  seen.set(title.toLowerCase(), 1);

  return title;
}

function pageTitleSuffix(markdown) {
  const url = markdown.match(/^URL:\s+(?:\[[^\]]+\]\(([^)]+)\)|(https?:\/\/\S+))/m)?.[1]
    || markdown.match(/^URL:\s+https?:\/\/\S+/m)?.[0]?.replace(/^URL:\s+/, "");

  if (!url) {
    return "";
  }

  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const last = segments.pop() || "";

    return titleCaseWords(last.replace(/[-_]+/g, " "));
  } catch {
    return "";
  }
}

async function publish(plan, loadedConfig) {
  const client = createConfluenceClient(loadedConfig);
  const spaceId = await getSpaceId(client, loadedConfig.spaceKey);
  const published = new Map();

  for (const doc of plan.docs) {
    const parentId = doc.parentKey === "__external_parent__"
      ? loadedConfig.parentPageId
      : published.get(doc.parentKey)?.id || "";

    const page = await upsertPage(client, {
      spaceId,
      parentId,
      title: doc.title,
      html: doc.html,
      versionMessage: loadedConfig.versionMessage || "Published by Soho Home Feature Docs",
    });

    published.set(doc.key, page);
    console.log(`${page.created ? "Created" : "Updated"} ${doc.title}: ${page.url || page.id}`);

    if (loadedConfig.uploadImages !== false) {
      for (const attachment of doc.attachments) {
        await upsertAttachment(client, page.id, attachment.file, attachment.filename);
      }
    }
  }
}

function createConfluenceClient(loadedConfig) {
  const baseUrl = requiredConfig(loadedConfig.baseUrl || process.env.ATLASSIAN_BASE_URL, "baseUrl or ATLASSIAN_BASE_URL")
    .replace(/\/+$/, "");
  const username = requiredConfig(loadedConfig.username || process.env.ATLASSIAN_EMAIL, "username or ATLASSIAN_EMAIL");
  const apiToken = requiredConfig(loadedConfig.apiToken || process.env.ATLASSIAN_API_TOKEN, "apiToken or ATLASSIAN_API_TOKEN");
  const authHeader = `Basic ${Buffer.from(`${username}:${apiToken}`).toString("base64")}`;

  return {
    baseUrl,
    async request(method, requestPath, payload = null, headers = {}) {
      const response = await fetch(`${baseUrl}${requestPath}`, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: authHeader,
          ...(payload instanceof FormData ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body: payload instanceof FormData ? payload : payload ? JSON.stringify(payload) : undefined,
      });
      const text = await response.text();
      const data = text ? safeJson(text) : null;

      if (!response.ok) {
        const message = data?.message || data?.errors?.[0]?.message || text || response.statusText;
        const error = new Error(`${method} ${requestPath} failed with HTTP ${response.status}: ${message}`);
        error.status = response.status;
        error.data = data;
        throw error;
      }

      return data;
    },
  };
}

async function getSpaceId(client, spaceKey) {
  const key = requiredConfig(spaceKey || process.env.CONFLUENCE_SPACE_KEY, "spaceKey or CONFLUENCE_SPACE_KEY");
  const data = await client.request("GET", `/wiki/api/v2/spaces?keys=${encodeURIComponent(key)}&limit=1`);
  const space = (data.results || []).find((item) => item.key === key) || data.results?.[0];

  if (!space?.id) {
    fail(`Confluence space not found for key ${key}`);
  }

  return space.id;
}

async function upsertPage(client, page) {
  const existing = await findPage(client, page.spaceId, page.title, page.parentId);

  if (!existing) {
    const created = await client.request("POST", "/wiki/api/v2/pages", {
      spaceId: page.spaceId,
      status: "current",
      title: page.title,
      parentId: page.parentId || undefined,
      body: {
        representation: "storage",
        value: page.html,
      },
    });

    return normalisePublishedPage(client, created, true);
  }

  return updatePageWithRetry(client, existing, page);
}

async function updatePageWithRetry(client, existing, page) {
  try {
    const updated = await updatePage(client, existing, page);

    return normalisePublishedPage(client, updated, false);
  } catch (error) {
    if (error.status !== 409) {
      throw error;
    }

    const latest = await findPage(client, page.spaceId, page.title, page.parentId);

    if (!latest) {
      throw error;
    }

    const updated = await updatePage(client, latest, page);

    return normalisePublishedPage(client, updated, false);
  }
}

async function updatePage(client, existing, page) {
  return client.request("PUT", `/wiki/api/v2/pages/${existing.id}`, {
    id: existing.id,
    status: "current",
    title: page.title,
    spaceId: page.spaceId,
    parentId: page.parentId || existing.parentId || undefined,
    body: {
      representation: "storage",
      value: page.html,
    },
    version: {
      number: Number(existing.version?.number || 1) + 1,
      message: page.versionMessage,
    },
  });
}

async function findPage(client, spaceId, title, parentId) {
  const data = await client.request(
    "GET",
    `/wiki/api/v2/pages?space-id=${encodeURIComponent(spaceId)}&title=${encodeURIComponent(title)}&status=current&limit=25`
  );
  const exact = (data.results || []).filter((page) => page.title === title);

  if (parentId) {
    return exact.find((page) => String(page.parentId || "") === String(parentId)) || null;
  }

  return exact[0] || null;
}

function normalisePublishedPage(client, page, created) {
  return {
    id: page.id,
    title: page.title,
    created,
    version: page.version?.number || 1,
    url: page._links?.webui
      ? `${client.baseUrl}${page._links.webui}`
      : "",
  };
}

async function upsertAttachment(client, pageId, file, filename) {
  const form = attachmentForm(file, filename);

  try {
    await client.request(
      "POST",
      `/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`,
      form,
      { "X-Atlassian-Token": "nocheck" }
    );
    return;
  } catch (error) {
    if (error.status !== 409) {
      throw error;
    }
  }

  const existing = await client.request(
    "GET",
    `/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment?filename=${encodeURIComponent(filename)}`
  );
  const attachmentId = existing.results?.[0]?.id;

  if (!attachmentId) {
    throw new Error(`Attachment upload conflicted but no attachment was found for ${filename}`);
  }

  await client.request(
    "POST",
    `/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment/${encodeURIComponent(attachmentId)}/data`,
    attachmentForm(file, filename),
    { "X-Atlassian-Token": "nocheck" }
  );
}

function attachmentForm(file, filename) {
  const form = new FormData();
  const buffer = readFileSync(file);
  const blob = new Blob([buffer], { type: mimeType(filename) });

  form.append("file", blob, filename);
  form.append("minorEdit", "true");
  form.append("comment", "Published by Soho Home Feature Docs");

  return form;
}

function markdownToStorage(markdown, context) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  const attachments = [];
  let listType = "";

  const closeList = () => {
    if (!listType) {
      return;
    }

    html.push(`</${listType}>`);
    listType = "";
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);

    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 6);
      html.push(`<h${level}>${inlineMarkdown(heading[2], context, attachments)}</h${level}>`);
      continue;
    }

    const image = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);

    if (image) {
      closeList();
      const attachment = attachmentForImage(image[2], image[1], context);

      if (attachment) {
        attachments.push(attachment);
        html.push(`<p><ac:image ac:alt="${escapeAttr(image[1])}"><ri:attachment ri:filename="${escapeAttr(attachment.filename)}" /></ac:image></p>`);
      }
      continue;
    }

    const unordered = trimmed.match(/^-\s+(.+)$/);

    if (unordered) {
      if (listType !== "ul") {
        closeList();
        html.push("<ul>");
        listType = "ul";
      }

      html.push(`<li>${inlineMarkdown(unordered[1], context, attachments)}</li>`);
      continue;
    }

    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);

    if (ordered) {
      if (listType !== "ol") {
        closeList();
        html.push("<ol>");
        listType = "ol";
      }

      html.push(`<li>${inlineMarkdown(ordered[1], context, attachments)}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${inlineMarkdown(trimmed, context, attachments)}</p>`);
  }

  closeList();

  return {
    html: html.join("\n"),
    attachments: uniqueAttachments(attachments),
  };
}

function inlineMarkdown(value, context, attachments) {
  let text = escapeHtml(value);

  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, href) => {
    const attachment = attachmentForImage(href, alt, context);

    if (!attachment) {
      return "";
    }

    attachments.push(attachment);

    return `<ac:image ac:alt="${escapeAttr(alt)}"><ri:attachment ri:filename="${escapeAttr(attachment.filename)}" /></ac:image>`;
  });

  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => confluenceLink(label, href, context));
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");

  return text;
}

function confluenceLink(label, href, context) {
  const targetTitle = localPageTitle(href, context);

  if (targetTitle) {
    return `<ac:link><ri:page ri:content-title="${escapeAttr(targetTitle)}" /><ac:plain-text-link-body><![CDATA[${label}]]></ac:plain-text-link-body></ac:link>`;
  }

  return `<a href="${escapeAttr(href)}">${label}</a>`;
}

function localPageTitle(href, context) {
  if (/^(https?:|mailto:|#)/i.test(href)) {
    return "";
  }

  const resolved = normaliseRelativePath(path.relative(
    context.rootDir,
    path.resolve(path.dirname(context.sourceFile), href)
  ));

  return context.titleByKey.get(resolved) || "";
}

function attachmentForImage(href, alt, context) {
  if (/^https?:/i.test(href)) {
    return null;
  }

  const file = path.resolve(path.dirname(context.sourceFile), href);

  if (!existsSync(file) || !statSync(file).isFile()) {
    return null;
  }

  return {
    file,
    filename: safeAttachmentName(file, alt),
  };
}

function safeAttachmentName(file, alt) {
  const basename = path.basename(file);

  if (basename && basename !== "page-desktop.png") {
    return basename;
  }

  const prefix = String(alt || path.basename(path.dirname(file)) || "image")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "image";

  return `${prefix}-${basename}`;
}

function uniqueAttachments(attachments) {
  const seen = new Set();

  return attachments.filter((attachment) => {
    const key = `${attachment.file}|${attachment.filename}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

function parseIndexPageLinks(markdown) {
  const links = new Map();
  const linkRegex = /^\d+\.\s+(?:\*\*)?\[([^\]]+)\]\(([^)]+)\)(?:\*\*)?/gm;
  let match;

  while ((match = linkRegex.exec(markdown))) {
    links.set(normaliseRelativePath(match[2]), match[1]);
  }

  return links;
}

function publishParentKey(page, relativeDocFile, indexLinkKeys) {
  if (indexLinkKeys.has(relativeDocFile)) {
    return "index.md";
  }

  const parent = (page.relatedPages || [])
    .map((relatedPage) => normaliseRelativePath(relatedPage.docFile || ""))
    .find((docFile) => indexLinkKeys.has(docFile));

  return parent || "index.md";
}

function childPageTitle(rootTitle, screenTitle) {
  const title = String(screenTitle || rootTitle).trim();

  if (/(feature documentation|documentation index)$/i.test(rootTitle)) {
    return title;
  }

  if (title.toLowerCase().startsWith(rootTitle.toLowerCase())) {
    return title;
  }

  return `${rootTitle} - ${title}`;
}

function firstMarkdownHeading(markdown) {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || "";
}

function normaliseRelativePath(value) {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

function titleCaseWords(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .replace(/\bUk\b/g, "UK")
    .replace(/\bEu\b/g, "EU")
    .replace(/\bUs\b/g, "US");
}

function mimeType(filename) {
  const ext = path.extname(filename).toLowerCase();

  return {
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
  }[ext] || "application/octet-stream";
}

function printDryRun(plan) {
  console.log(`Confluence dry run for ${plan.rootDir}`);
  console.log(`Root page: ${plan.rootTitle}`);

  for (const doc of plan.docs) {
    const parent = doc.parentKey ? ` parent=${doc.parentKey}` : "";

    console.log(`- ${doc.title}${parent}`);
    console.log(`  source: ${path.relative(process.cwd(), doc.file)}`);
    console.log(`  attachments: ${doc.attachments.length}`);
  }
}

function loadConfig(parsedArgs) {
  const configPath = parsedArgs.config || "";

  if (!configPath) {
    return {};
  }

  const resolved = path.resolve(process.cwd(), configPath);

  if (!existsSync(resolved)) {
    fail(`Config file not found: ${resolved}`);
  }

  return JSON.parse(readFileSync(resolved, "utf8"));
}

function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--config") {
      parsed.config = requireValue(argv, index += 1, arg);
    } else if (arg === "--docs") {
      parsed.docs = requireValue(argv, index += 1, arg);
    } else if (arg === "--title") {
      parsed.title = requireValue(argv, index += 1, arg);
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requireValue(argv, index, flag) {
  if (!argv[index]) {
    fail(`${flag} requires a value.`);
  }

  return argv[index];
}

function requiredConfig(value, label) {
  if (!value) {
    fail(`Missing ${label}.`);
  }

  return value;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function printHelp() {
  console.log(`Usage: node confluence-sync.mjs --docs docs/<run-name> [--config confluence.json] [--dry-run]

Options:
  --docs <path>      Feature Docs run folder containing index.md and summary.json.
  --config <path>    JSON config with Confluence credentials and publish options.
  --title <title>    Override the root Confluence page title.
  --dry-run          Print the publish plan without calling Confluence.

Config/env:
  baseUrl            Atlassian site URL, or ATLASSIAN_BASE_URL.
  username           Atlassian account email, or ATLASSIAN_EMAIL.
  apiToken           Atlassian API token, or ATLASSIAN_API_TOKEN.
  spaceKey           Confluence space key, or CONFLUENCE_SPACE_KEY.
  parentPageId       Optional existing Confluence parent page id.
  uploadImages       Defaults to true.
`);
}
