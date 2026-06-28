#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const config = loadConfig(args);
const runStartedAt = new Date();
const runName = args.output || config.runName || `run-${formatTimestamp(runStartedAt)}`;
const outputRoot = resolveFromScriptDir(config.outputDir || "docs");
const runDir = path.resolve(outputRoot, runName);
const pagesDir = path.join(runDir, "pages");
const codeDocsRoot = resolveFromScriptDir(config.codeDocs?.outputDir || "../code-docs");
let serverProcess;
let authMiddlewareEnabled = false;
let codeIndex = null;
let composerPsr4Mappings = null;
const routeMetadataByUrl = new Map();
const crawlStats = {
  skippedDuplicateRoutes: 0,
  skippedDisallowedUrls: 0,
  skippedInaccessibleUrls: 0,
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  if (args.clean && existsSync(runDir)) {
    rmSync(runDir, { recursive: true, force: true });
  }

  mkdirSync(pagesDir, { recursive: true });

  if (config.startCommand) {
    console.log(`Starting app: ${config.startCommand}`);
    serverProcess = spawnShell(config.startCommand, { cwd: repoRoot, prefix: "app" });
    await sleep(Number(config.startWaitMs || 3000));
  }

  try {
    const { chromium } = await importPackage("playwright");
    const browser = await chromium.launch({ headless: true });

    try {
      const pages = await documentPages(browser);
      attachRelatedPages(pages);
      pages.forEach(writePageMarkdown);
      writeCodeDocs(pages);
      writeIndex(pages);
      writeAgentContext(pages);
      writeSummary(pages);
      console.log(`\nFeature docs written to ${path.relative(repoRoot, runDir)}`);
    } finally {
      await browser.close();
    }
  } finally {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
    }

    if (authMiddlewareEnabled) {
      ensureAuthMiddlewareDisabled();
    }
  }
}

async function documentPages(browser) {
  const crawlConfig = config.crawl || {};
  const crawlEnabled = args.noCrawl ? false : crawlConfig.enabled !== false;
  const maxPages = Number(args.maxPages || crawlConfig.maxPages || 1);
  const queue = [];
  const visited = new Set();
  const queued = new Set();
  const pages = [];
  const contextCache = new Map();

  validateAuthRequirements(config);

  if (requiresAuthMiddleware(config)) {
    ensureAuthMiddlewareEnabled();
  }

  for (const startUrl of loadStartUrls(config, args)) {
    enqueueDocumentationUrl(queue, queued, startUrl);
  }

  try {
    while (queue.length && pages.length < maxPages) {
      const url = queue.shift();
      const resolvedUrl = resolveUrl(url);
      const visitKey = documentationVisitKey(resolvedUrl);

      queued.delete(visitKey);

      if (visited.has(visitKey) || !isAllowedUrl(resolvedUrl, config)) {
        if (visited.has(visitKey)) {
          crawlStats.skippedDuplicateRoutes += 1;
        } else {
          crawlStats.skippedDisallowedUrls += 1;
        }

        continue;
      }

      visited.add(visitKey);
      console.log(`Documenting ${resolvedUrl}`);

      const pageDoc = await capturePage(browser, resolvedUrl, pages.length + 1, contextCache);

      if (!pageDoc) {
        crawlStats.skippedInaccessibleUrls += 1;
        continue;
      }

      pages.push(pageDoc);

      if (!crawlEnabled) {
        continue;
      }

      const priorityLinks = [];
      const normalLinks = [];

      for (const link of discoverNextDocumentationUrls(pageDoc)) {
        const nextKey = documentationVisitKey(link);

        if (visited.has(nextKey) || queued.has(nextKey)) {
          crawlStats.skippedDuplicateRoutes += 1;
          continue;
        }

        if (!isAllowedUrl(link, config)) {
          crawlStats.skippedDisallowedUrls += 1;
          continue;
        }

        if (isRelatedCrudDocumentationUrl(pageDoc, link)) {
          priorityLinks.push(link);
        } else {
          normalLinks.push(link);
        }
      }

      for (const link of priorityLinks.slice().reverse()) {
        enqueueDocumentationUrl(queue, queued, link, { priority: true });
      }

      for (const link of normalLinks) {
        enqueueDocumentationUrl(queue, queued, link);
      }
    }
  } finally {
    await closeBrowserContexts(contextCache);
  }

  return pages;
}

function enqueueDocumentationUrl(queue, queued, url, options = {}) {
  const resolvedUrl = resolveUrl(url);
  const key = documentationVisitKey(resolvedUrl);

  if (queued.has(key)) {
    crawlStats.skippedDuplicateRoutes += 1;
    return false;
  }

  if (options.priority) {
    queue.unshift(resolvedUrl);
  } else {
    queue.push(resolvedUrl);
  }

  queued.add(key);

  return true;
}

function discoverNextDocumentationUrls(pageDoc) {
  return [
    ...pageDoc.discoveredLinks.filter((link) => shouldFollowDiscoveredLink(pageDoc, link)),
    ...discoverControllerActionUrls(pageDoc),
  ];
}

function attachRelatedPages(pages) {
  const groups = new Map();

  pages.forEach((pageDoc) => {
    const key = relatedPageGroupKey(pageDoc);

    if (!key) {
      pageDoc.relatedPages = [];
      return;
    }

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(pageDoc);
  });

  groups.forEach((group) => {
    const sortedGroup = [...group].sort(compareRelatedPages);

    sortedGroup.forEach((pageDoc) => {
      pageDoc.relatedPages = sortedGroup.filter((relatedPage) => relatedPage !== pageDoc);
    });
  });
}

function relatedPageGroupKey(pageDoc) {
  const route = pageDoc.codeContext?.route;

  if (route?.controllerAlias) {
    const parsed = new URL(pageDoc.url);

    return [
      parsed.origin,
      route.cp ? "cp" : "site",
      route.controllerAlias,
    ].join("|");
  }

  return "";
}

function compareRelatedPages(left, right) {
  return relatedPageWeight(left) - relatedPageWeight(right)
    || featurePageIndexTitle(left).localeCompare(featurePageIndexTitle(right));
}

function relatedPageWeight(pageDoc) {
  const pathname = new URL(pageDoc.url).pathname;

  if (/\/edit\/new\/?$/i.test(pathname) || /\/(?:new|add|create)\/?$/i.test(pathname)) {
    return 10;
  }

  if (/\/(?:edit|show|view)(?:\/|$)/i.test(pathname)) {
    return 20;
  }

  return 0;
}

async function capturePage(browser, url, pageNumber, contextCache) {
  const pageSlug = pageSlugForUrl(url, pageNumber);
  const pageDir = path.join(pagesDir, pageSlug);
  const imageDir = path.join(pageDir, "images");
  mkdirSync(imageDir, { recursive: true });

  const screenshots = [];
  let extracted = null;
  let fieldScreenshots = [];
  let discoveredLinks = [];
  let technicalError = "";
  let inaccessibleReason = "";

  for (const viewport of config.viewports) {
    const context = await browserContextForViewport(browser, viewport, contextCache);
    const authCookie = buildAuthCookie(config, url);

    if (authCookie) {
      await context.addCookies([authCookie]);
    }

    const page = await context.newPage();

    try {
      const response = await page.goto(url, {
        waitUntil: config.waitUntil || "networkidle",
        timeout: Number(config.timeoutMs || 45000),
      });

      await dismissConfiguredText(page);
      await waitForReadySelector(page);
      await sleep(Number(config.postNavigateWaitMs || 0));
      await applyViewportZoom(page, viewport);

      inaccessibleReason = await getInaccessiblePageReason(page, response);

      if (inaccessibleReason) {
        break;
      }

      if (!extracted) {
        extracted = await extractPageData(page);
        discoveredLinks = await extractLinks(page);
        await redactSensitivePageData(page);
        fieldScreenshots = await captureFieldScreenshots(page, extracted.fields, imageDir);
      }

      const screenshotFile = path.join(imageDir, `page-${slug(viewport.name)}.png`);
      await page.screenshot({
        path: screenshotFile,
        fullPage: viewport.fullPage !== false,
      });
      screenshots.push({
        viewport: viewport.name,
        file: screenshotFile,
        relativeFile: relativeTo(pageDir, screenshotFile),
        width: viewport.width,
        height: viewport.height,
      });
    } catch (error) {
      technicalError = error.message;
      const diagnosticFile = path.join(imageDir, `page-${slug(viewport.name)}-error.png`);

      try {
        await page.screenshot({ path: diagnosticFile, fullPage: true });
        screenshots.push({
          viewport: `${viewport.name}-error`,
          file: diagnosticFile,
          relativeFile: relativeTo(pageDir, diagnosticFile),
          width: viewport.width,
          height: viewport.height,
        });
      } catch (screenshotError) {
        technicalError = `${technicalError}; screenshot failed: ${screenshotError.message}`;
      }
    } finally {
      await closePage(page);
    }
  }

  if (inaccessibleReason) {
    rmSync(pageDir, { recursive: true, force: true });
    console.log(`Skipping ${url} (${inaccessibleReason})`);
    return null;
  }

  if (!extracted) {
    extracted = buildEmptyExtract(url, technicalError);
  }

  const routeMetadata = routeMetadataForUrl(url);
  const codeContext = analyseCodeForUrl(url, extracted);
  const analysis = analysePage(url, extracted, technicalError, codeContext, routeMetadata);
  const routeKey = documentationVisitKey(url);
  const extractedTitle = isNoisyCpTitle(extracted.title) ? "" : extracted.title;
  const headingTitle = isNoisyCpTitle(extracted.headings[0]?.text) ? "" : extracted.headings[0]?.text;
  const pageDoc = {
    slug: pageSlug,
    url,
    routeKey,
    title: analysis.title || extractedTitle || headingTitle || url,
    pageDir,
    docFile: path.join(pageDir, "README.md"),
    screenshots,
    fieldScreenshots,
    extracted,
    analysis,
    codeContext,
    routeMetadata,
    discoveredLinks,
    technicalError,
  };

  return pageDoc;
}

async function getInaccessiblePageReason(page, response) {
  const status = response?.status();

  if (status === 401 || status === 403) {
    return `HTTP ${status}`;
  }

  let pageState = null;

  try {
    pageState = await page.evaluate(() => {
      const normalise = (value) => String(value || "").replace(/\s+/g, " ").trim();

      return {
        path: window.location.pathname,
        title: normalise(document.title),
        heading: normalise(document.querySelector("h1")?.textContent),
        bodyStart: normalise(document.body?.innerText).slice(0, 500),
      };
    });
  } catch {
    return "";
  }

  const searchableText = `${pageState.title} ${pageState.heading} ${pageState.bodyStart}`;

  if (/\/cp\/(?:login|forgotten-password)\/?$/i.test(pageState.path)) {
    return "redirected to CP login";
  }

  if (/\baccess denied\b/i.test(`${pageState.title} ${pageState.heading}`)) {
    return "access denied";
  }

  if (/^(access denied|you do not have permission|missing permissions)\b/i.test(pageState.bodyStart)) {
    return "access denied";
  }

  if (/\b(you do not have permission|you don't have permission|missing permissions)\b/i.test(searchableText)) {
    return "access denied";
  }

  return "";
}

async function browserContextForViewport(browser, viewport, contextCache) {
  const key = viewportContextKey(viewport);

  if (contextCache.has(key)) {
    return contextCache.get(key);
  }

  const context = await browser.newContext(buildContextConfig(viewport));

  if (Array.isArray(config.cookies) && config.cookies.length) {
    await context.addCookies(config.cookies);
  }

  contextCache.set(key, context);

  return context;
}

function viewportContextKey(viewport) {
  return JSON.stringify({
    name: viewport.name || "",
    context: buildContextConfig(viewport),
  });
}

async function closeBrowserContexts(contextCache) {
  for (const context of contextCache.values()) {
    await context.close();
  }

  contextCache.clear();
}

async function closePage(page) {
  try {
    await page.close();
  } catch {
    // The browser or context may already be closed after a navigation failure.
  }
}

async function redactSensitivePageData(page) {
  await page.evaluate(() => {
    const normalise = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const sensitivePattern = /\b(token|refresh token|access token|secret|password|api key|bearer|authorization|auth header|session|cookie)\b/i;
    const isSensitive = (value) => sensitivePattern.test(normalise(value));

    document.querySelectorAll("table").forEach((table) => {
      const headers = Array.from(table.querySelectorAll("thead th, tr:first-child th")).map((cell) => normalise(cell.textContent));
      const sensitiveIndexes = headers
        .map((header, index) => isSensitive(header) ? index : -1)
        .filter((index) => index >= 0);

      if (!sensitiveIndexes.length) {
        return;
      }

      const rows = Array.from(table.querySelectorAll("tbody tr"));
      const fallbackRows = rows.length ? rows : Array.from(table.querySelectorAll("tr")).slice(headers.length ? 1 : 0);

      fallbackRows.forEach((row) => {
        const cells = Array.from(row.children).filter((cell) => /^(td|th)$/i.test(cell.tagName));

        sensitiveIndexes.forEach((index) => {
          if (cells[index]) {
            cells[index].textContent = "[hidden]";
            cells[index].removeAttribute("title");
          }
        });
      });
    });

    document.querySelectorAll("input, textarea").forEach((field) => {
      const descriptor = [
        field.getAttribute("name"),
        field.getAttribute("id"),
        field.getAttribute("aria-label"),
        field.closest("label")?.textContent,
      ].map(normalise).join(" ");

      if (!isSensitive(descriptor)) {
        return;
      }

      field.value = "[hidden]";
      field.setAttribute("value", "[hidden]");
      field.removeAttribute("title");
    });
  });
}

function buildContextConfig(viewport) {
  const contextConfig = {
    viewport: {
      width: Number(viewport.width || 1440),
      height: Number(viewport.height || 1100),
    },
    deviceScaleFactor: Number(viewport.deviceScaleFactor || 1),
    ignoreHTTPSErrors: Boolean(config.ignoreHTTPSErrors),
  };

  if (config.storageStatePath) {
    const storageStatePath = resolveProjectPath(config.storageStatePath);

    if (!existsSync(storageStatePath)) {
      fail(`storageStatePath not found: ${storageStatePath}`);
    }

    contextConfig.storageState = storageStatePath;
  }

  if (config.extraHTTPHeaders && Object.keys(config.extraHTTPHeaders).length) {
    contextConfig.extraHTTPHeaders = config.extraHTTPHeaders;
  }

  return contextConfig;
}

async function waitForReadySelector(page) {
  if (!config.readySelector) {
    return;
  }

  await page.waitForSelector(config.readySelector, {
    timeout: Number(config.readyTimeoutMs || 15000),
  });
}

async function applyViewportZoom(page, viewport) {
  const zoom = Number(viewport.zoom || viewport.cssZoom || 1);

  if (!zoom || zoom === 1) {
    return;
  }

  await page.evaluate((zoomValue) => {
    document.documentElement.style.zoom = String(zoomValue);
    document.documentElement.style.transformOrigin = "0 0";
    document.body.style.transformOrigin = "0 0";
  }, zoom);
}

async function dismissConfiguredText(page) {
  const dismissText = Array.isArray(config.dismissText) ? config.dismissText : [];

  if (!dismissText.length) {
    return;
  }

  await page.evaluate((texts) => {
    const lowered = texts.map((text) => String(text).toLowerCase());
    const controls = Array.from(document.querySelectorAll("button, a, input[type='button'], input[type='submit']"));

    for (const control of controls) {
      const text = (control.innerText || control.value || control.getAttribute("aria-label") || "").trim().toLowerCase();

      if (text && lowered.some((needle) => text.includes(needle))) {
        control.click();
        return;
      }
    }
  }, dismissText).catch(() => {});
}

async function extractPageData(page) {
  return page.evaluate(() => {
    const text = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const attr = (node, name) => node?.getAttribute(name) || "";
    const normalise = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = (node) => {
      if (!node || !(node instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();

      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0;
    };
    const labelFor = (field) => {
      const labels = field.labels ? Array.from(field.labels).map(text).filter(Boolean) : [];

      if (labels.length) {
        return labels.join(" / ");
      }

      const id = field.id;

      if (id) {
        const labelled = document.querySelector(`label[for="${CSS.escape(id)}"]`);

        if (labelled && text(labelled)) {
          return text(labelled);
        }
      }

      const labelledBy = attr(field, "aria-labelledby");

      if (labelledBy) {
        const label = labelledBy
          .split(/\s+/)
          .map((labelId) => text(document.getElementById(labelId)))
          .filter(Boolean)
          .join(" / ");

        if (label) {
          return label;
        }
      }

      const closestLabel = field.closest("label");

      if (closestLabel && text(closestLabel)) {
        return text(closestLabel);
      }

      return attr(field, "aria-label") || attr(field, "placeholder") || field.name || field.id || field.tagName.toLowerCase();
    };
    const describedBy = (field) => {
      const ids = attr(field, "aria-describedby");
      const descriptions = [];

      if (ids) {
        descriptions.push(...ids.split(/\s+/).map((id) => text(document.getElementById(id))).filter(Boolean));
      }

      const container = field.closest(".field, .form-field, .form__field, .control-group, .form-group, .input-group, li, p, td, tr");

      if (container) {
        const helper = container.querySelector(".hint, .help, .help-block, .form-text, .description, .note, small");

        if (helper && text(helper)) {
          descriptions.push(text(helper));
        }
      }

      return [...new Set(descriptions)].join(" ");
    };
    const optionData = (field) => {
      if (!(field instanceof HTMLSelectElement)) {
        return [];
      }

      return Array.from(field.options).slice(0, 30).map((option) => ({
        label: text(option) || option.label || option.value,
        value: option.value,
        selected: option.selected,
      }));
    };
    const valuePreview = (field) => {
      const type = (field.type || "").toLowerCase();

      if (type === "password") {
        return "[password field]";
      }

      if (type === "checkbox" || type === "radio") {
        return field.checked ? "checked" : "not checked";
      }

      return String(field.value || "").slice(0, 120);
    };
    const screenshotTarget = (field) => {
      const selectors = [
        "label",
        ".field",
        ".form-field",
        ".form__field",
        ".control-group",
        ".form-group",
        ".field-group",
        ".input-group",
        ".setting",
        "li",
        "p",
        "td",
        "tr",
      ];

      for (const selector of selectors) {
        const candidate = field.closest(selector);

        if (!candidate || !(candidate instanceof HTMLElement)) {
          continue;
        }

        const rect = candidate.getBoundingClientRect();

        if (rect.width > 0 && rect.height > 0 && rect.height <= 520 && rect.width <= window.innerWidth * 0.95 && !candidate.hasAttribute("data-feature-doc-shot-id")) {
          return candidate;
        }
      }

      return field;
    };
    const isUtilityControl = (field) => {
      const label = normalise(labelFor(field));
      const name = normalise(field.name || attr(field, "name"));
      const id = normalise(field.id);
      const placeholder = normalise(attr(field, "placeholder"));
      const utilityValues = new Set([
        "jump to",
        "p",
        "rich text editor",
        "rxcompositioncutter0",
        "rxcompositioncutter1",
        "rxcompositioncutter2",
        "rxcompositioncutter3",
      ]);

      if (utilityValues.has(label) || utilityValues.has(name) || utilityValues.has(id)) {
        return true;
      }

      return label === "search" || (!label && placeholder === "search");
    };
    const formHeading = (form) => {
      if (!form) {
        return "";
      }

      const heading = form.querySelector("legend, h1, h2, h3, h4, .title, .heading");

      return text(heading) || attr(form, "aria-label") || form.name || form.id || "";
    };
    const fields = [];
    const fieldNodes = Array.from(document.querySelectorAll([
      "input:not([type='hidden'])",
      "select",
      "textarea",
      "[contenteditable='true']",
      "[role='textbox']",
      "[role='combobox']",
      "[role='checkbox']",
      "[role='switch']",
      "[role='radio']",
    ].join(",")))
      .filter(visible)
      .filter((field) => !isUtilityControl(field));

    fieldNodes.forEach((field, index) => {
      const uid = `field-${String(index + 1).padStart(3, "0")}`;
      const target = screenshotTarget(field);
      field.setAttribute("data-feature-doc-field-id", uid);
      target.setAttribute("data-feature-doc-shot-id", uid);

      fields.push({
        index: index + 1,
        uid,
        tag: field.tagName.toLowerCase(),
        type: attr(field, "type") || attr(field, "role") || field.tagName.toLowerCase(),
        name: field.name || attr(field, "name"),
        id: field.id || "",
        label: labelFor(field),
        placeholder: attr(field, "placeholder"),
        required: Boolean(field.required || attr(field, "aria-required") === "true"),
        disabled: Boolean(field.disabled || attr(field, "aria-disabled") === "true"),
        readOnly: Boolean(field.readOnly || attr(field, "readonly")),
        valuePreview: valuePreview(field),
        helpText: describedBy(field),
        options: optionData(field),
        form: formHeading(field.form || field.closest("form")),
        selector: `[data-feature-doc-field-id="${uid}"]`,
        screenshotSelector: `[data-feature-doc-shot-id="${uid}"]`,
      });
    });

    const forms = Array.from(document.querySelectorAll("form")).filter(visible).map((form, index) => ({
      index: index + 1,
      name: form.name || "",
      id: form.id || "",
      heading: formHeading(form),
      method: attr(form, "method") || "get",
      action: attr(form, "action"),
      fieldIndexes: fields.filter((field) => form.contains(document.querySelector(field.selector))).map((field) => field.index),
    }));
    const buttons = Array.from(document.querySelectorAll("button, input[type='submit'], input[type='button'], a.button, a.btn, [role='button']"))
      .filter(visible)
      .slice(0, 80)
      .map((button, index) => ({
        index: index + 1,
        text: text(button) || attr(button, "value") || attr(button, "aria-label"),
        type: attr(button, "type") || attr(button, "role") || button.tagName.toLowerCase(),
      }))
      .filter((button) => button.text);
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4"))
      .filter(visible)
      .slice(0, 80)
      .map((heading) => ({
        level: heading.tagName.toLowerCase(),
        text: text(heading),
      }))
      .filter((heading) => heading.text);
    const landmarks = Array.from(document.querySelectorAll("main, nav, aside, header, footer, section, [role='main'], [role='navigation'], [role='search']"))
      .filter(visible)
      .slice(0, 60)
      .map((landmark) => ({
        tag: landmark.tagName.toLowerCase(),
        role: attr(landmark, "role"),
        label: attr(landmark, "aria-label") || text(landmark.querySelector("h1, h2, h3, h4")) || "",
      }));
    const tables = Array.from(document.querySelectorAll("table"))
      .filter(visible)
      .slice(0, 10)
      .map((table, index) => {
        const headers = Array.from(table.querySelectorAll("thead th, tr:first-child th"))
          .map(text)
          .filter(Boolean);
        const bodyRows = Array.from(table.querySelectorAll("tbody tr")).filter(visible);
        const fallbackRows = Array.from(table.querySelectorAll("tr")).filter(visible).slice(headers.length ? 1 : 0);
        const rowNodes = bodyRows.length ? bodyRows : fallbackRows;
        const rows = rowNodes.slice(0, 5).map((row) => Array.from(row.children)
          .filter((cell) => /^(td|th)$/i.test(cell.tagName) && visible(cell))
          .map(text));

        return {
          index: index + 1,
          caption: text(table.querySelector("caption")),
          headers,
          rowCount: rowNodes.length,
          rows,
        };
      });
    const actionLinks = Array.from(document.querySelectorAll("a[href]"))
      .filter(visible)
      .slice(0, 120)
      .map((link, index) => ({
        index: index + 1,
        text: text(link) || attr(link, "aria-label") || attr(link, "title"),
        href: link.href,
      }))
      .filter((link) => link.text && link.href);

    return {
      title: document.title || "",
      url: window.location.href,
      headings,
      forms,
      fields,
      buttons,
      landmarks,
      tables,
      actionLinks,
      textPreview: text(document.body).slice(0, 5000),
    };
  });
}

async function extractLinks(page) {
  const crawlConfig = config.crawl || {};
  const linkSelector = crawlConfig.linkSelector || "a";

  return page.evaluate(({ selector, expandCrud, preferCrudLinks }) => {
    const text = (node) => (node?.innerText || node?.textContent || node?.getAttribute("aria-label") || node?.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    const normaliseFeaturePath = (pathname) => pathname
      .replace(/\/(?:new|add|create)\/?$/i, "")
      .replace(/\/(?:edit|show|view|copy|duplicate)(?:\/[^/]+)?\/?$/i, "")
      .replace(/\/$/, "");
    const currentFeaturePath = normaliseFeaturePath(window.location.pathname);
    const crudText = /^(create new|create|new|add|edit|view|show)$/i;
    const blocked = /(?:\/action(?:\/|$)|[?&](?:action|method)=|\/(?:new|add|create)\/[^/?#]+|\/(?:delete|remove|logout|impersonate|export|download|print|send|sync|import|process|queue|retry|accept|approve|reject|decline|cancel|capture|refund|resend|flush|clear|expire|undelete|restore|duplicate|copy)(?:\/|$|\?)|d3r_debug)/i;
    const links = [];
    const seenCrudTypes = new Set();
    const add = (link) => {
      if (!link?.href || blocked.test(link.href)) {
        return;
      }

      links.push(link.href);
    };

    if (expandCrud) {
      Array.from(document.querySelectorAll("a[href]")).forEach((link) => {
        const linkUrl = new URL(link.href, window.location.href);
        const linkText = text(link);

        if (linkUrl.origin !== window.location.origin || !linkUrl.pathname.startsWith(currentFeaturePath)) {
          return;
        }

        if (crudText.test(linkText) || /\/(?:new|add|create|edit|show|view)(?:\/|$)/i.test(linkUrl.pathname)) {
          const crudType = /\/(?:new|add|create)(?:\/|$)/i.test(linkUrl.pathname) || /create|new|add/i.test(linkText)
            ? "create"
            : "edit";

          if (seenCrudTypes.has(crudType)) {
            return;
          }

          seenCrudTypes.add(crudType);
          add(link);
        }
      });
    }

    if (preferCrudLinks) {
      return [...new Set(links)].filter(Boolean);
    }

    Array.from(document.querySelectorAll(selector)).forEach(add);

    return [...new Set(links)].filter(Boolean);
  }, {
    selector: linkSelector,
    expandCrud: crawlConfig.expandCrud !== false,
    preferCrudLinks: Boolean(args.urls.length && crawlConfig.expandCrud !== false),
  }).catch(() => []);
}

async function captureFieldScreenshots(page, fields, imageDir) {
  const maxScreenshots = Number(config.maxFieldScreenshotsPerPage || 80);
  const captured = [];

  for (const field of fields.slice(0, maxScreenshots)) {
    const file = path.join(imageDir, `${field.uid}-${slug(field.label || field.name || "field")}.png`);

    try {
      const locator = page.locator(field.screenshotSelector).first();
      await captureFieldScreenshot(page, locator, file);
      captured.push({
        fieldUid: field.uid,
        fieldIndex: field.index,
        file,
        relativeFile: relativeTo(path.dirname(imageDir), file),
      });
    } catch (error) {
      captured.push({
        fieldUid: field.uid,
        fieldIndex: field.index,
        error: error.message,
      });
    }
  }

  return captured;
}

async function captureFieldScreenshot(page, locator, file) {
  const timeout = Number(config.fieldScreenshotTimeoutMs || 5000);
  const padding = Number(config.fieldScreenshotPaddingPx ?? 8);

  await locator.scrollIntoViewIfNeeded({ timeout });

  if (padding <= 0) {
    await locator.screenshot({ path: file, timeout });
    return;
  }

  const box = await locator.boundingBox({ timeout });

  if (!box || box.width <= 0 || box.height <= 0) {
    await locator.screenshot({ path: file, timeout });
    return;
  }

  const viewport = page.viewportSize();
  const clip = {
    x: Math.max(0, Math.floor(box.x - padding)),
    y: Math.max(0, Math.floor(box.y - padding)),
    width: Math.ceil(box.width + padding * 2),
    height: Math.ceil(box.height + padding * 2),
  };

  if (viewport) {
    clip.width = Math.min(clip.width, Math.max(1, Math.floor(viewport.width - clip.x)));
    clip.height = Math.min(clip.height, Math.max(1, Math.floor(viewport.height - clip.y)));
  }

  await page.screenshot({ path: file, clip });
}

function analysePage(url, extracted, technicalError, codeContext, routeMetadata = null) {
  const controllerTitle = codeContext.controller?.title || codeContext.controller?.listingTitle || "";
  const routeTitle = routeMetadata?.title || "";
  const extractedTitle = isNoisyCpTitle(extracted.title) ? "" : extracted.title;
  const headingTitle = isNoisyCpTitle(extracted.headings[0]?.text) ? "" : extracted.headings[0]?.text;
  const title = routeTitle || controllerTitle || headingTitle || extractedTitle || titleFromUrl(url);
  const modelName = codeContext.model?.alias || codeContext.model?.className || "";
  const codeFeatureSummary = buildCodeFeatureSummary(title, codeContext);
  codeContext.featureSummary = codeFeatureSummary;
  const featurePurpose = inferFeatureSpecificPurpose(title, url, extracted) || codeFeatureSummary.description;
  const purposeParts = [];

  if (technicalError) {
    purposeParts.push(`This page could not be fully captured. ${technicalError}`);
  } else if (featurePurpose) {
    purposeParts.push(featurePurpose);
  } else if (controllerTitle || routeTitle || title) {
    purposeParts.push(inferHumanPagePurpose(title, url, extracted));
  } else {
    purposeParts.push("This screen gives admins a place to review the captured details and decide what needs to be updated.");
  }

  if (modelName && config.humanDocs?.includeTechnicalReferences) {
    purposeParts.push(`Saved values appear to be backed by ${modelName}.`);
  }

  return normaliseAnalysis({
    title,
    purpose: purposeParts.join(" "),
    workflows: inferWorkflows(title, url, extracted),
    howToUse: inferHowToUse(title, url, extracted),
    primaryActions: selectPrimaryActions(extracted.buttons),
    contextNotes: codeFeatureSummary.notes,
    fieldDocs: extracted.fields.map((field) => ({
      index: field.index,
      label: field.label,
      howToUse: inferFieldHowToUse(field),
      effects: inferFieldEffect(field, codeContext),
      validation: field.required ? "Required." : "No required marker detected.",
      notes: fieldNotes(field, codeContext),
    })),
    sideEffects: inferSideEffects(codeContext),
    screenshotNotes: [],
    unansweredQuestions: [
      "Codex should read the referenced controller, model, XML, and view files before treating this draft as final operator documentation.",
    ],
  }, extracted);
}

function normaliseAnalysis(analysis, extracted) {
  const fieldDocs = Array.isArray(analysis.fieldDocs) ? analysis.fieldDocs : [];
  const fieldDocByIndex = new Map(fieldDocs.map((field) => [Number(field.index), field]));

  return {
    title: String(analysis.title || extracted.title || extracted.headings[0]?.text || "Untitled page"),
    purpose: String(analysis.purpose || "This screen gives admins a place to review the details and make the relevant changes."),
    workflows: Array.isArray(analysis.workflows) ? analysis.workflows : [],
    howToUse: ensureArray(analysis.howToUse),
    primaryActions: ensureArray(analysis.primaryActions),
    contextNotes: ensureArray(analysis.contextNotes),
    fieldDocs: extracted.fields.map((field) => {
      const doc = fieldDocByIndex.get(Number(field.index)) || {};

      return {
        index: field.index,
        label: String(doc.label || field.label || field.name || `Field ${field.index}`),
        howToUse: String(doc.howToUse || "Use this field when it is relevant to the change you are making."),
        effects: String(doc.effects || ""),
        validation: String(doc.validation || (field.required ? "Required." : "No required marker detected.")),
        notes: String(doc.notes || field.helpText || ""),
      };
    }),
    sideEffects: ensureArray(analysis.sideEffects),
    screenshotNotes: ensureArray(analysis.screenshotNotes),
    unansweredQuestions: ensureArray(analysis.unansweredQuestions),
  };
}

function inferFeatureSpecificPurpose(title, url, extracted) {
  if (!isDiscountPermissionFeature(title)) {
    return "";
  }

  const pathname = new URL(url).pathname;

  if (/\/edit\/new\/?$/i.test(pathname)) {
    return "This form is for adding a discount limit for an admin role.";
  }

  if (/\/edit\/[^/]+\/?$/i.test(pathname)) {
    return "This form is for checking or updating the discount limits assigned to an admin role.";
  }

  if ((extracted.tables || []).length) {
    return "The listing shows the role-based limits that control custom discounts.";
  }

  return "Discount Permission Settings keeps the role-based custom discount limits in one place.";
}

function inferHumanPagePurpose(title, url, extracted) {
  const parsed = new URL(url);
  const pathname = parsed.pathname;
  const featureName = sentenceFeatureName(title);
  const itemName = sentenceFeatureName(singularFeatureName(title));
  const hasTable = (extracted.tables || []).length > 0;
  const hasForm = (extracted.forms || []).length > 0;
  const hasCreate = hasCreateAction(extracted, url);
  const hasEdit = hasEditAction(extracted, url);
  const hasView = hasViewAction(extracted, url);
  const hasSave = hasSaveAction(extracted);

  if (/\/edit\/new\/?$/i.test(pathname)) {
    return `Use this screen when you need to create a new ${itemName}. It brings the fields together so the details can be checked and saved in one place.`;
  }

  if (/\/edit\/[^/]+\/?$/i.test(pathname)) {
    return hasSave
      ? `Use this screen when you need to check or change an existing ${itemName}.`
      : `Use this screen when you need to check an existing ${itemName}.`;
  }

  if (hasTable && hasForm) {
    if (hasCreate || hasEdit) {
      return `${title} lets admins find existing ${featureName}, then create or edit them when changes are needed.`;
    }

    if (hasView) {
      return `${title} lets admins find existing ${featureName} and open a record when more detail is needed.`;
    }

    return `${title} lets admins find and review existing ${featureName}.`;
  }

  if (hasTable) {
    if (hasEdit) {
      return `${title} is used to find and review existing ${featureName}. Open a row when you need to see or change the details.`;
    }

    if (hasView) {
      return `${title} is used to find and review existing ${featureName}. Open a row when you need to see the full details.`;
    }

    return `${title} is used to find and review existing ${featureName}.`;
  }

  if (hasForm) {
    return hasSave
      ? `${title} contains the fields an admin uses to maintain this ${itemName}.`
      : `${title} shows the details for this ${itemName}.`;
  }

  return `${title} brings together the controls used to manage ${featureName}.`;
}

function inferWorkflows(title, url, extracted) {
  const specificWorkflows = inferFeatureSpecificWorkflows(title, url, extracted);

  if (specificWorkflows.length) {
    return specificWorkflows;
  }

  const workflows = [];
  const parsed = new URL(url);
  const isCp = parsed.pathname.startsWith("/cp");
  const recordName = singularFeatureName(title);
  const humanRecordName = sentenceFeatureName(recordName);
  const humanFeatureName = sentenceFeatureName(title);
  const isCreatePage = isCreateActionPath(parsed.pathname);
  const isEditPage = isEditActionPath(parsed.pathname);
  const isViewPage = isViewActionPath(parsed.pathname);
  const hasCreate = hasCreateAction(extracted, url);
  const hasEditLink = hasEditAction(extracted, url);
  const hasViewLink = hasViewAction(extracted, url);
  const hasSave = hasSaveAction(extracted);
  const hasEdit = hasEditLink || (isEditPage && hasSave);
  const hasView = hasViewLink || isViewPage || (isEditPage && !hasSave);
  const hasOpen = hasEdit || hasView;
  const hasSearch = (extracted.fields || []).some((field) => /search/i.test(`${field.label} ${field.name} ${field.type}`));

  if (isCp && (extracted.tables || []).length) {
    workflows.push({
      title: `Review ${humanFeatureName}`,
      body: listingWorkflowBody(humanRecordName, hasSearch, hasEdit, hasView),
      items: primaryTableColumns(extracted).map((column) => `Field: ${column}`),
    });
  }

  if (isCp && (hasCreate || isCreatePage)) {
    workflows.push({
      title: `Create a new ${humanRecordName}`,
      body: `Use Create new when this ${humanRecordName} does not already exist. Complete the fields that describe it, then save.`,
      items: [],
    });
  }

  if (isCp && hasEdit) {
    workflows.push({
      title: `Edit an existing ${humanRecordName}`,
      body: `Open an existing ${humanRecordName} when you need to check the setup or make a change.`,
      items: hasSave ? ["Save once the details are correct."] : [],
    });
  } else if (isCp && hasOpen) {
    workflows.push({
      title: `Review an existing ${humanRecordName}`,
      body: `Open an existing ${humanRecordName} when you need to check the full details.`,
      items: [],
    });
  } else if (isCp && hasSave && extracted.forms.length) {
    workflows.push({
      title: "Update settings",
      body: "Use the fields on this screen to make the change, then save once the values are correct.",
      items: [],
    });
  }

  return workflows;
}

function listingWorkflowBody(humanRecordName, hasSearch, hasEdit, hasView) {
  if (hasEdit) {
    return hasSearch
      ? `Search or filter the visible fields to find the ${humanRecordName} you need, then open the row when a change is needed.`
      : `Review what already exists, then open a row when a change is needed.`;
  }

  if (hasView) {
    return hasSearch
      ? `Search or filter the visible fields to find the ${humanRecordName} you need, then open the row to check the full details.`
      : `Review what already exists, then open a row when you need the full details.`;
  }

  return hasSearch
    ? `Search or filter the visible fields to find the ${humanRecordName} you need.`
    : `Review the visible fields to check what already exists.`;
}

function inferFeatureSpecificWorkflows(title, url, extracted) {
  if (!isDiscountPermissionFeature(title)) {
    return [];
  }

  const workflows = [];
  const parsed = new URL(url);
  const isCreatePage = /\/edit\/new\/?$/i.test(parsed.pathname);
  const isEditPage = !isCreatePage && isEditActionPath(parsed.pathname);
  const hasListing = (extracted.tables || []).length > 0;
  const hasSave = hasSaveAction(extracted);
  const hasCreate = hasCreateAction(extracted, url);
  const hasEdit = hasEditAction(extracted, url) || (isEditPage && hasSave);

  if (hasListing) {
    workflows.push({
      title: "Review role limits",
      body: "Start here to see which admin roles already have custom discount limits set.",
      items: primaryTableColumns(extracted).map((column) => `Field: ${column}`),
    });
  }

  if (isCreatePage) {
    workflows.push({
      title: "Create a role limit",
      body: "Complete the form to create a discount limit for an admin role.",
      items: hasSave ? ["Save once the role and limits are correct."] : [],
    });
  } else if (hasListing && hasCreate) {
    workflows.push({
      title: "Create a role limit",
      body: "Choose Create new when a role needs its own discount limit.",
      items: [],
    });
  }

  if (hasEdit) {
    workflows.push({
      title: "Edit a role limit",
      body: "Open an existing role limit to change the percentage cap or fixed amount cap.",
      items: hasSave ? ["Save when the updated limits look right."] : [],
    });
  } else if (isEditPage) {
    workflows.push({
      title: "Review a role limit",
      body: "Open the role limit when you need to check the current percentage cap or fixed amount cap.",
      items: [],
    });
  }

  if (extracted.forms.length && (isCreatePage || isEditPage) && hasSave) {
    workflows.push({
      title: "Set the discount limit",
      body: "Choose the role, enter the maximum percentage discount, and add a fixed amount cap if needed.",
      items: [
        "Use 100 for an unlimited percentage allowance.",
        "Use 0 in Max Discount Amount for no fixed-amount cap.",
      ],
    });
  }

  return workflows;
}

function inferHowToUse(title, url, extracted) {
  const specificSteps = inferFeatureSpecificHowToUse(title, url, extracted);

  if (specificSteps.length) {
    return specificSteps;
  }

  const recordName = singularFeatureName(title);
  const humanRecordName = sentenceFeatureName(recordName);
  const hasCreate = hasCreateAction(extracted, url);
  const hasEdit = hasEditAction(extracted, url);
  const hasView = hasViewAction(extracted, url);
  const hasSearch = (extracted.fields || []).some((field) => /search/i.test(`${field.label} ${field.name} ${field.type}`));

  if ((extracted.tables || []).length) {
    const actionStep = listingHowToUseActionStep(humanRecordName, hasCreate, hasEdit, hasView);

    return [
      `Open ${title} from the CP navigation.`,
      hasSearch ? `Search or filter until you find the ${humanRecordName} you need.` : `Scan the fields in the table to find the ${humanRecordName} you need.`,
      actionStep,
    ].filter(Boolean);
  }

  if (extracted.forms.length) {
    const pathname = new URL(url).pathname;
    const hasSave = hasSaveAction(extracted);

    if (/\/edit\/new\/?$/i.test(pathname)) {
      return [
        `Create the new ${humanRecordName} from this screen.`,
        "Work through the fields that are relevant to the new record.",
        hasSave ? "Save once the details are correct." : "",
      ].filter(Boolean);
    }

    if (isEditActionPath(pathname) && hasSave) {
      return [
        `Open the existing ${humanRecordName} you need to change.`,
        "Work through the fields that are relevant to the change.",
        "Save once the details are correct.",
      ];
    }

    if (isEditActionPath(pathname) || isViewActionPath(pathname)) {
      return [
        `Open the existing ${humanRecordName} you need to review.`,
        "Use the visible fields to check the details.",
      ];
    }

    return [
      `Open the ${title} screen.`,
      hasSave
        ? "Work through the fields that are relevant to the change, then save once the details are correct."
        : "Use the visible fields to check the details.",
    ];
  }

  return [`Open ${title} and use the available controls for the change you are making.`];
}

function inferFeatureSpecificHowToUse(title, url, extracted) {
  if (!isDiscountPermissionFeature(title)) {
    return [];
  }

  const pathname = new URL(url).pathname;

  if ((extracted.tables || []).length) {
    const hasCreate = hasCreateAction(extracted, url);
    const hasEdit = hasEditAction(extracted, url);
    const actionStep = hasCreate && hasEdit
      ? "Select Create new to add a role limit, or Edit to update an existing one."
      : hasCreate
        ? "Select Create new to add a role limit."
        : hasEdit
          ? "Open an existing role limit when the values need updating."
          : "";

    return [
      `Open the ${title} page from the CP navigation or direct URL.`,
      "Review the role, maximum percentage, and maximum fixed amount columns.",
      actionStep,
    ].filter(Boolean);
  }

  if (/\/edit\/new\/?$/i.test(pathname)) {
    return [
      "Choose the admin role the discount limit applies to.",
      "Enter the maximum percentage discount and optional fixed amount cap.",
      hasSaveAction(extracted) ? "Select Save to create the role limit." : "",
    ].filter(Boolean);
  }

  if (extracted.forms.length && hasSaveAction(extracted)) {
    return [
      "Review the selected role and current discount limits.",
      "Update the maximum percentage discount or fixed amount cap where needed.",
      "Select Save to apply the updated limit.",
    ];
  }

  if (extracted.forms.length) {
    return [
      "Review the selected role and current discount limits.",
    ];
  }

  return [];
}

function listingHowToUseActionStep(humanRecordName, hasCreate, hasEdit, hasView) {
  if (hasCreate && hasEdit) {
    return `Open a row to check the details or make a change, or create a new ${humanRecordName} if it does not already exist.`;
  }

  if (hasCreate) {
    return `Create a new ${humanRecordName} if it does not already exist.`;
  }

  if (hasEdit) {
    return "Open a row when you need to check the details or make a change.";
  }

  if (hasView) {
    return "Open a row when you need to check the full details.";
  }

  return "";
}

function isCreateActionLink(link) {
  if (!link?.href) {
    return false;
  }

  const pathname = new URL(link.href, config.baseUrl).pathname;

  return isCreateActionPath(pathname);
}

function hasCreateAction(extracted, currentUrl) {
  return (extracted.actionLinks || []).some((link) => isCreateActionLink(link) && isSameFeatureActionLink(link, currentUrl));
}

function hasEditAction(extracted, currentUrl) {
  return (extracted.actionLinks || []).some((link) => isEditActionLink(link) && isSameFeatureActionLink(link, currentUrl));
}

function hasViewAction(extracted, currentUrl) {
  return (extracted.actionLinks || []).some((link) => isViewActionLink(link) && isSameFeatureActionLink(link, currentUrl));
}

function hasSaveAction(extracted) {
  return (extracted.buttons || []).some((button) => /^save\b/i.test(normaliseHumanLabel(button.text || "")));
}

function isEditActionLink(link) {
  if (!link?.href) {
    return false;
  }

  const pathname = new URL(link.href, config.baseUrl).pathname;
  const text = normaliseHumanLabel(link.text || "");

  return isEditActionPath(pathname) || (/^edit$/i.test(text) && !isCreateActionPath(pathname));
}

function isViewActionLink(link) {
  if (!link?.href) {
    return false;
  }

  const pathname = new URL(link.href, config.baseUrl).pathname;
  const text = normaliseHumanLabel(link.text || "");

  return isViewActionPath(pathname) || /^(view|show)$/i.test(text);
}

function isSameFeatureActionLink(link, currentUrl) {
  if (!link?.href || !currentUrl) {
    return true;
  }

  const current = new URL(currentUrl, config.baseUrl);
  const target = new URL(link.href, config.baseUrl);

  if (current.origin !== target.origin) {
    return false;
  }

  return normaliseFeatureActionPath(current.pathname) === normaliseFeatureActionPath(target.pathname);
}

function normaliseFeatureActionPath(pathname) {
  return String(pathname || "")
    .replace(/\/edit\/new\/?$/i, "")
    .replace(/\/(?:new|add|create)\/?$/i, "")
    .replace(/\/(?:edit|show|view)(?:\/[^/]+)?\/?$/i, "")
    .replace(/\/$/, "");
}

function isCreateActionPath(pathname) {
  return /\/edit\/new\/?$/i.test(pathname) || /\/(?:new|add|create)\/?$/i.test(pathname);
}

function isEditActionPath(pathname) {
  return !isCreateActionPath(pathname) && /\/edit(?:\/[^/]+)?\/?$/i.test(pathname);
}

function isViewActionPath(pathname) {
  return /\/(?:show|view)(?:\/[^/]+)?\/?$/i.test(pathname);
}

function singularFeatureName(title) {
  return String(title || "record")
    .replace(/\s+Settings$/i, " Setting")
    .replace(/ies$/i, "y")
    .replace(/s$/i, "");
}

function sentenceFeatureName(value) {
  return markdownText(value)
    .split(/\s+/)
    .map((word) => (isAcronymWord(word) ? word : word.toLowerCase()))
    .join(" ");
}

function isPluralFeatureName(value) {
  const text = markdownText(value);

  return /s$/i.test(text) && !/settings$/i.test(text);
}

function humanList(values) {
  const items = values.map(markdownText).filter(Boolean);

  if (items.length <= 1) {
    return items[0] || "";
  }

  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }

  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function isAcronymWord(word) {
  const plain = String(word || "").replace(/[^a-z0-9]/gi, "");

  return plain.length > 1 && /^[A-Z0-9]+$/.test(plain);
}

function primaryTableColumns(extracted) {
  const table = (extracted.tables || []).find((item) => item.headers?.length);

  if (!table) {
    return [];
  }

  return table.headers
    .map((header) => header.trim())
    .filter(Boolean)
    .filter((header) => !/^actions?$/i.test(header))
    .slice(0, 12);
}

function selectPrimaryActions(buttons) {
  const seen = new Set();

  return buttons
    .map((button) => String(button.text || "").trim())
    .filter(Boolean)
    .filter((text) => !isCommonActionText(text))
    .filter((text) => {
      const key = text.toLowerCase();

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);

      return true;
    });
}

function isCommonActionText(text) {
  const normalised = normaliseHumanLabel(text);
  const ignored = new Set([
    "add",
    "add filter",
    "bold",
    "create new",
    "edit columns",
    "export csv",
    "export",
    "first",
    "format",
    "html",
    "italic",
    "jump",
    "last",
    "link",
    "list",
    "next",
    "previous",
    "redo",
    "save",
    "search",
    "sort by default",
    "special characters",
    "underline",
    "undo",
    "unlink",
  ]);

  return ignored.has(normalised) || /^sort by\b/i.test(normalised) || /^\d+$/.test(normalised);
}

function inferFieldHowToUse(field) {
  const label = displayFieldLabel({ label: field.label || field.name }, field);
  const type = String(field.type || field.tag || "").toLowerCase();
  const normalisedLabel = normaliseHumanLabel(label);
  const fieldName = sentenceFeatureName(label);

  if (normalisedLabel === "role") {
    return "Choose the admin role this discount limit applies to.";
  }

  if (normalisedLabel.includes("max discount percentage")) {
    return "Enter the highest percentage discount this role can apply.";
  }

  if (normalisedLabel.includes("max discount amount")) {
    return "Enter the highest fixed discount amount this role can apply, or use 0 for no fixed-amount cap.";
  }

  if (field.placeholder) {
    return `Use the expected format shown by the placeholder: "${field.placeholder}".`;
  }

  if (repeatedFieldKey(field.name)) {
    return `Set the ${humanNameFromFieldName(field.name)} value for each relevant row in this section.`;
  }

  if (field.options?.length || ["select", "select-one", "select-multiple", "radio"].includes(type)) {
    return `Choose the option that matches this ${fieldName}.`;
  }

  if (["checkbox", "switch"].includes(type)) {
    if (/^(is|has|can|show|hide|enable|disable)\b/i.test(label)) {
      return "Turn this on when the answer should be yes. Leave it off when it should not apply.";
    }

    return `Turn this on when ${fieldName} should apply. Leave it off when it should not.`;
  }

  if (type === "textarea") {
    return `Write the ${fieldName} content.`;
  }

  return `Add the ${fieldName}.`;
}

function analyseCodeForUrl(url, extracted) {
  if (config.codeAnalysis?.enabled === false) {
    return {
      enabled: false,
      route: routePartsForUrl(url),
      references: [],
      modelFields: [],
    };
  }

  const index = getCodeIndex();
  const route = routePartsForUrl(url, index);
  const controllerMatch = matchController(route, index.controllers);
  const controller = controllerMatch
    ? buildControllerContext(controllerMatch, route, index)
    : null;
  const model = controller?.modelAlias
    ? buildModelContext(controller.modelAlias, index)
    : null;
  const references = [
    ...(controller?.references || []),
    ...(model?.references || []),
  ];

  return {
    enabled: true,
    route,
    controller,
    model,
    modelFields: model?.fields || [],
    references: uniqueReferences(references),
    fieldMatches: matchDomFieldsToModelFields(extracted.fields, model?.fields || [], model),
  };
}

function getCodeIndex() {
  if (codeIndex) {
    return codeIndex;
  }

  const providerFiles = resolveProviderFiles(config.codeAnalysis?.providerGlobs || []);
  const controllers = new Map();
  const models = new Map();
  const routePatterns = [];

  for (const file of providerFiles) {
    const content = readLimited(file);
    const namespaceName = extractNamespace(content);
    const uses = extractUseMap(content);

    for (const [alias, className] of parseControllerAliases(content, namespaceName, uses)) {
      controllers.set(alias, {
        alias,
        className,
        providerFile: file,
      });
    }

    for (const [alias, className] of parseModelAliases(content, namespaceName, uses)) {
      models.set(alias, {
        alias,
        className,
        providerFile: file,
      });
    }

    routePatterns.push(...parseRoutePatterns(content, file));
  }

  codeIndex = {
    providerFiles,
    controllers,
    models,
    routePatterns: routePatterns.sort(routePatternSort),
  };

  return codeIndex;
}

function buildControllerContext(match, route, index) {
  const className = match.controller.className;
  const file = classToFile(className);
  const content = file && existsSync(file) ? readLimited(file) : "";
  const namespaceName = extractNamespace(content);
  const uses = extractUseMap(content);
  const extendsClass = resolvePhpClass(extractExtendsClass(content), namespaceName, uses);
  const parentFile = extendsClass ? classToFile(extendsClass) : "";
  const parentContent = parentFile && existsSync(parentFile) ? readLimited(parentFile) : "";
  const modelAlias = extractControllerProperty(content, "_modelClass") || extractControllerProperty(parentContent, "_modelClass");
  const title = extractControllerProperty(content, "_title") || extractControllerProperty(parentContent, "_title");
  const listingTitle = extractControllerProperty(content, "_listingTitle") || extractControllerProperty(parentContent, "_listingTitle");
  const render = extractControllerProperty(content, "_render") || extractControllerProperty(parentContent, "_render");
  const action = route.action || match.action || "index";
  const actionMethod = `${action.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())}Action`;
  const methods = [...new Set([...extractMethodNames(parentContent), ...extractMethodNames(content)])];
  const viewReferences = file ? findViewReferences(file, content, render, action) : [];
  const providerContent = match.controller.providerFile && existsSync(match.controller.providerFile) ? readLimited(match.controller.providerFile) : "";
  const combinedContent = `${parentContent}\n${content}`;
  const references = [
    reference("provider", match.controller.providerFile),
    reference("controller", file),
    reference("parent-controller", parentFile),
    ...viewReferences,
    ...referencedClassReferences(providerContent),
  ];

  return {
    alias: match.alias,
    className,
    file,
    action,
    actionMethod,
    hasActionMethod: methods.includes(actionMethod),
    extendsClass,
    parentFile,
    modelAlias,
    title,
    listingTitle,
    render,
    docSummary: extractClassDocSummary(content) || extractClassDocSummary(parentContent),
    methodSummaries: extractMethodSummaries(combinedContent),
    actionTexts: extractActionTexts(combinedContent),
    references: uniqueReferences(references),
  };
}

function buildModelContext(alias, index) {
  const model = index.models.get(alias);

  if (!model) {
    return {
      alias,
      className: "",
      file: "",
      xmlFile: "",
      fields: [],
      references: [],
    };
  }

  const file = classToFile(model.className);
  const content = file && existsSync(file) ? readLimited(file) : "";
  const namespaceName = extractNamespace(content);
  const uses = extractUseMap(content);
  const parentClass = resolvePhpClass(extractExtendsClass(content), namespaceName, uses);
  const parentFile = parentClass ? classToFile(parentClass) : "";
  const parentContent = parentFile && existsSync(parentFile) ? readLimited(parentFile) : "";
  const xmlFile = findModelXmlFile(file);
  const fields = xmlFile ? parseModelXmlFields(xmlFile) : [];
  const itemName = extractControllerProperty(content, "_itemName") || extractControllerProperty(parentContent, "_itemName");
  const tableName = extractControllerProperty(content, "_tableName") || extractControllerProperty(parentContent, "_tableName");
  const combinedContent = `${parentContent}\n${content}`;

  return {
    alias,
    className: model.className,
    file,
    xmlFile,
    itemName,
    tableName,
    parentClass,
    parentFile,
    fields,
    docSummary: extractClassDocSummary(content) || extractClassDocSummary(parentContent),
    methodSummaries: extractMethodSummaries(combinedContent),
    actionTexts: extractActionTexts(combinedContent),
    references: uniqueReferences([
      reference("provider", model.providerFile),
      reference("model", file),
      reference("parent-model", parentFile),
      reference("model-xml", xmlFile),
      ...referencedClassReferences(combinedContent),
    ]),
  };
}

function buildCodeFeatureSummary(title, codeContext) {
  if (!codeContext?.enabled) {
    return {
      description: "",
      notes: [],
    };
  }

  const titleText = markdownText(title);
  const description = inferDomainCodeDescription(titleText, codeContext) || inferDocblockDescription(titleText, codeContext);
  const notes = [
    ...inferDomainCodeNotes(titleText, codeContext),
    ...inferActionNotes(codeContext),
    ...inferModelFieldNotes(codeContext),
  ].map(markdownText).filter(Boolean);

  return {
    description,
    notes: [...new Set(notes)].slice(0, 5),
  };
}

function inferDomainCodeDescription(title, codeContext) {
  const haystack = codeContextText(title, codeContext);
  const identity = codeContextIdentityText(title, codeContext);

  if (/access token|access-tokens/i.test(identity) && /refresh token|expires|service|instance/i.test(haystack)) {
    return `${title} store integration access and refresh tokens for services that need authenticated API calls.`;
  }

  if (/accounting logs?/i.test(identity)) {
    return `${title} record Sage and Avalara accounting activity so integration issues and resolution status can be reviewed.`;
  }

  if (/adjustments-summary-admin|adjustments?/i.test(identity)) {
    return `${title} summarise order adjustments and related finance-system transfer activity for review.`;
  }

  if (/ais-client-outbound-logs|outbound api logs/i.test(identity)) {
    return `${title} record outbound AIS API requests so sent data, failures, and debug activity can be reviewed.`;
  }

  if (/ais-client-product-logs|product api logs/i.test(identity)) {
    return `${title} record product-related AIS API activity so product sync issues can be investigated.`;
  }

  if (/ais-client-settings|client api settings/i.test(identity)) {
    return `${title} control AIS client sync behaviour, including Business Central sync and scheduled pricing update settings.`;
  }

  if (/anomaly-anomalies|^anomalies$/i.test(identity)) {
    return `${title} list detected anomalies where recorded counts differ from the expected range.`;
  }

  if (/anomaly-detectors|anomaly detectors/i.test(identity)) {
    return `${title} define the checks, schedule, thresholds, and alerts used to detect unusual data patterns.`;
  }

  if (/webhook/i.test(identity) && /token/i.test(identity)) {
    const plural = isPluralFeatureName(title);
    return `${title} ${plural ? "are bearer tokens" : "is a bearer token"} used to authorise incoming AIS webhook requests before the site accepts the data they send.`;
  }

  if (/webhook/i.test(identity) && /log/i.test(identity)) {
    return isPluralFeatureName(title)
      ? `${title} record incoming AIS webhook activity so failed or processed requests can be reviewed later.`
      : `${title} records incoming AIS webhook activity so failed or processed requests can be reviewed later.`;
  }

  return "";
}

function inferDomainCodeNotes(title, codeContext) {
  const haystack = codeContextText(title, codeContext);
  const identity = codeContextIdentityText(title, codeContext);
  const notes = [];

  if (/access token|access-tokens/i.test(identity) && /refresh token|expires|service|instance/i.test(haystack)) {
    notes.push("Each record belongs to a service and instance, which lets separate integrations keep their own credentials.");
    notes.push("Expiry dates help identify tokens that may need to be refreshed before an integration stops working.");
  }

  if (/webhook/i.test(identity) && /token/i.test(identity)) {
    if (/Authorization|bearer|findFirstByTokenAndStatusAndEnvironment/i.test(haystack)) {
      notes.push("Incoming webhook calls must send the token as a bearer token. The request is rejected unless the token is active and belongs to the current environment.");
    }

    if (/isAllowedService|getServiceOptions|services\(\)/i.test(haystack)) {
      notes.push("Each token can be limited to selected webhook services, so access can be granted for only the AIS feeds that need it.");
    }

    if (/refreshToken|generateNewToken/i.test(haystack)) {
      notes.push("Refreshing a token generates a replacement value. Any external system using the old value must be updated afterwards.");
    }

    if (/revokeToken|canRevoke/i.test(haystack)) {
      notes.push("Revoking a token marks it inactive, which stops future webhook requests from authenticating with it.");
    }

    if (/updateLastAccessed|last_accessed/i.test(haystack)) {
      notes.push("Last Accessed is updated after a successful request, which helps confirm whether a webhook integration is still using the token.");
    }
  }

  return notes;
}

function codeContextIdentityText(title, codeContext) {
  return [
    title,
    codeContext.route?.controllerAlias,
    codeContext.controller?.className,
    codeContext.controller?.alias,
    codeContext.controller?.title,
    codeContext.controller?.listingTitle,
    codeContext.model?.alias,
    codeContext.model?.className,
  ].filter(Boolean).join(" ");
}

function inferDocblockDescription(title, codeContext) {
  const summaries = [
    codeContext.controller?.docSummary,
    codeContext.model?.docSummary,
    ...referenceDocSummaries(codeContext.references || []),
  ].map(markdownText).filter(Boolean);
  const summary = summaries.find((item) => !isThinCodeSummary(item));

  if (!summary) {
    return "";
  }

  return humaniseCodeSummary(title, summary);
}

function referenceDocSummaries(references) {
  return references
    .map((item) => item.file)
    .filter(Boolean)
    .map((file) => file && existsSync(file) ? extractClassDocSummary(readLimited(file)) : "")
    .filter(Boolean);
}

function isThinCodeSummary(summary) {
  return /^(provider for this package|model|controller|admin controller)\.?$/i.test(summary)
    || /^webhooks? token model\.?$/i.test(summary)
    || /^tokens?\.?$/i.test(summary);
}

function humaniseCodeSummary(title, summary) {
  return summary
    .replace(/^Admin controller to list the /i, `${title} lists `)
    .replace(/^Admin controller to list /i, `${title} lists `)
    .replace(/\.$/, ".")
    .replace(/\s+/g, " ");
}

function inferActionNotes(codeContext) {
  const methods = [
    ...(codeContext.controller?.methodSummaries || []),
    ...(codeContext.model?.methodSummaries || []),
    ...referenceMethodSummaries(codeContext.references || []),
  ];
  const actionTexts = [
    ...(codeContext.controller?.actionTexts || []),
    ...(codeContext.model?.actionTexts || []),
  ];
  const notes = [];

  for (const method of methods) {
    const note = methodSummaryNote(method);

    if (note) {
      notes.push(note);
    }
  }

  for (const text of actionTexts) {
    if (/refresh token/i.test(text)) {
      notes.push("Refresh Token is available when the current value should be replaced.");
    } else if (/revoke token/i.test(text)) {
      notes.push("Revoke Token is available when access should be removed.");
    }
  }

  return notes;
}

function referenceMethodSummaries(references) {
  return references
    .map((item) => item.file)
    .filter(Boolean)
    .flatMap((file) => file && existsSync(file) ? extractMethodSummaries(readLimited(file)) : []);
}

function methodSummaryNote(method) {
  const name = String(method.name || "");
  const summary = markdownText(method.summary);

  if (/^refresh/i.test(name) && summary) {
    return `${summary.replace(/\.$/, "")}.`;
  }

  if (/^revoke/i.test(name) && summary) {
    return `${summary.replace(/\.$/, "")}.`;
  }

  if (/^isAllowedService$/i.test(name)) {
    return "The selected services decide which webhook endpoints the token is allowed to access.";
  }

  if (/^updateLastAccessed$/i.test(name)) {
    return "The system records when the token was last used successfully.";
  }

  return "";
}

function inferModelFieldNotes(codeContext) {
  const fields = codeContext.model?.fields || [];

  if (!fields.length) {
    return [];
  }

  const fieldNames = fields
    .map((field) => field.name)
    .filter(Boolean)
    .filter((name) => !/^(created|updated)$/i.test(name))
    .slice(0, 5);

  if (!fieldNames.length) {
    return [];
  }

  return [`The key fields are ${humanList(fieldNames)}, which explain what the record is for and how it can be used.`];
}

function codeContextText(title, codeContext) {
  const referenceText = (codeContext.references || [])
    .map((item) => item.file)
    .filter(Boolean)
    .map((file) => file && existsSync(file) ? readLimited(file) : "")
    .join("\n");

  return [
    title,
    codeContext.route?.controllerAlias,
    codeContext.controller?.className,
    codeContext.controller?.docSummary,
    codeContext.controller?.actionTexts?.join(" "),
    codeContext.controller?.methodSummaries?.map((method) => `${method.name} ${method.summary}`).join(" "),
    codeContext.model?.className,
    codeContext.model?.docSummary,
    codeContext.model?.methodSummaries?.map((method) => `${method.name} ${method.summary}`).join(" "),
    (codeContext.model?.fields || []).map((field) => `${field.name} ${field.dbname} ${field.type} ${field.description}`).join(" "),
    referenceText,
  ].filter(Boolean).join("\n");
}

function routePartsForUrl(url, index = null) {
  if (/^file:\/\//i.test(url)) {
    return {
      isFile: true,
      path: new URL(url).pathname,
      segments: [],
      controllerAlias: "",
      action: "index",
    };
  }

  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const cp = segments[0] === "cp";
  const routeSegments = cp ? segments.slice(1) : segments;

  const route = {
    isFile: false,
    cp,
    path: parsed.pathname,
    segments,
    routeSegments,
    controllerAlias: routeSegments[0] || "",
    action: routeSegments[1] || "index",
  };

  return index?.routePatterns?.length ? applyRoutePatternMatch(route, index.routePatterns) : route;
}

function applyRoutePatternMatch(route, routePatterns) {
  for (const pattern of routePatterns) {
    if (!routePatternMatches(route.routeSegments, pattern.segments)) {
      continue;
    }

    return {
      ...route,
      controllerAlias: pattern.controller || route.controllerAlias,
      action: resolveRoutePatternAction(pattern, route),
      routePattern: pattern,
    };
  }

  return route;
}

function routePatternMatches(routeSegments, patternSegments) {
  if (routeSegments.length !== patternSegments.length) {
    return false;
  }

  return patternSegments.every((segment, index) => {
    if (segment.startsWith(":")) {
      return Boolean(routeSegments[index]);
    }

    return segment === routeSegments[index];
  });
}

function resolveRoutePatternAction(pattern, route) {
  if (!pattern.action) {
    return route.action || "index";
  }

  if (!pattern.action.includes("|")) {
    return pattern.action;
  }

  const actions = pattern.action.split("|").filter(Boolean);

  return route.routeSegments.find((segment) => actions.includes(segment)) || actions[0] || "index";
}

function matchController(route, controllerMap) {
  if (!route.routeSegments?.length) {
    return null;
  }

  for (let length = route.routeSegments.length; length > 0; length -= 1) {
    const alias = route.routeSegments.slice(0, length).join("-");

    if (controllerMap.has(alias)) {
      return {
        alias,
        action: route.routeSegments[length] || "index",
        controller: controllerMap.get(alias),
      };
    }
  }

  const alias = route.controllerAlias;

  if (controllerMap.has(alias)) {
    return {
      alias,
      action: route.action || "index",
      controller: controllerMap.get(alias),
    };
  }

  return null;
}

function matchDomFieldsToModelFields(domFields, modelFields, modelContext = null) {
  const byDbName = new Map(modelFields.map((field) => [normaliseFieldName(field.dbname), field]));
  const byName = new Map(modelFields.map((field) => [normaliseFieldName(field.name), field]));
  const itemPrefix = normaliseFieldName(modelContext?.itemName);

  return domFields.map((field) => {
    const rawKeys = [
      field.name,
      field.id,
      field.label,
    ];
    const keys = rawKeys.map(normaliseFieldName).filter(Boolean);

    if (itemPrefix) {
      rawKeys
        .map(normaliseFieldName)
        .filter((key) => key.startsWith(itemPrefix))
        .forEach((key) => keys.push(key.slice(itemPrefix.length)));
    }

    for (const key of keys) {
      if (byDbName.has(key)) {
        return {
          fieldIndex: field.index,
          modelField: byDbName.get(key),
          matchedBy: "dbname",
        };
      }

      if (byName.has(key)) {
        return {
          fieldIndex: field.index,
          modelField: byName.get(key),
          matchedBy: "name",
        };
      }
    }

    return {
      fieldIndex: field.index,
      modelField: null,
      matchedBy: "",
    };
  });
}

function inferFieldEffect(field, codeContext) {
  const match = codeContext.fieldMatches?.find((item) => item.fieldIndex === field.index);
  const modelField = match?.modelField;
  const label = displayFieldLabel({ label: field.label || field.name }, field);
  const normalisedLabel = normaliseHumanLabel(label);

  if (normalisedLabel === "role") {
    return "Sets which admin role the discount limit applies to.";
  }

  if (normalisedLabel.includes("max discount percentage")) {
    return "Sets the highest percentage discount this role can apply.";
  }

  if (normalisedLabel.includes("max discount amount")) {
    return "Sets the highest fixed discount amount this role can apply.";
  }

  if (field.helpText && !/^optional$/i.test(field.helpText.trim())) {
    return field.helpText;
  }

  if (modelField) {
    return `Updates ${modelField.name || label || "this setting"}.`;
  }

  if (field.label || field.name) {
    return `Updates ${label || humanNameFromFieldName(field.name)}.`;
  }

  return "";
}

function fieldNotes(field, codeContext) {
  const notes = [];
  const match = codeContext.fieldMatches?.find((item) => item.fieldIndex === field.index);
  const modelField = match?.modelField;
  const label = displayFieldLabel({ label: field.label || field.name }, field);
  const normalisedLabel = normaliseHumanLabel(label);

  if (normalisedLabel.includes("max discount percentage")) {
    return "Enter a value from 0 to 100. Use 100 when the role should be able to apply any percentage discount.";
  }

  if (normalisedLabel.includes("max discount amount")) {
    return "Set this to 0 when the role should not have a fixed-amount cap.";
  }

  if (field.helpText && !/^optional$/i.test(field.helpText.trim())) {
    notes.push(field.helpText);
  }

  if (config.humanDocs?.includeFieldTechnicalDetails && modelField?.type) {
    notes.push(`Model XML type: ${modelField.type}.`);
  }

  if (config.humanDocs?.includeFieldTechnicalDetails && modelField?.dbname) {
    notes.push(`Model XML dbname: ${modelField.dbname}.`);
  }

  if (modelField?.description) {
    notes.push(modelField.description);
  }

  return notes.join(" ");
}

function inferSideEffects(codeContext) {
  const sideEffects = [];

  if (codeContext.controller?.file) {
    sideEffects.push(`Review ${relativeTo(repoRoot, codeContext.controller.file)} for save, edit, index, and custom action behaviour.`);
  }

  if (codeContext.model?.file) {
    sideEffects.push(`Review ${relativeTo(repoRoot, codeContext.model.file)} for getters, setters, validation, save hooks, and derived behaviour.`);
  }

  if (codeContext.model?.xmlFile) {
    sideEffects.push(`Review ${relativeTo(repoRoot, codeContext.model.xmlFile)} for field labels, types, relationships, and required settings.`);
  }

  return sideEffects;
}

function selectHumanFieldDocs(pageDoc) {
  const threshold = Number(config.humanDocs?.fieldDetailThreshold || 12);
  const maxFields = Number(config.humanDocs?.maxKeyFields || 24);

  if (pageDoc.analysis.fieldDocs.length <= threshold) {
    return dedupeRepeatedFieldDocs(pageDoc, pageDoc.analysis.fieldDocs.filter((fieldDoc) => {
      const field = pageDoc.extracted.fields.find((item) => item.index === fieldDoc.index);

      return field && !isUtilityField(field, fieldDoc);
    }));
  }

  return dedupeRepeatedFieldDocs(pageDoc, pageDoc.analysis.fieldDocs
    .filter((fieldDoc) => {
      const field = pageDoc.extracted.fields.find((item) => item.index === fieldDoc.index);

      return field && isFeatureField(pageDoc, field, fieldDoc);
    })
  ).slice(0, maxFields);
}

function dedupeRepeatedFieldDocs(pageDoc, fieldDocs) {
  const fieldsByIndex = new Map(pageDoc.extracted.fields.map((field) => [field.index, field]));
  const seen = new Set();

  return fieldDocs.filter((fieldDoc) => {
    const field = fieldsByIndex.get(fieldDoc.index);
    const repeatKey = repeatedFieldKey(field?.name);

    if (!repeatKey) {
      return true;
    }

    if (seen.has(repeatKey)) {
      return false;
    }

    seen.add(repeatKey);

    return true;
  });
}

function isFeatureField(pageDoc, field, fieldDoc) {
  if (isUtilityField(field, fieldDoc)) {
    return false;
  }

  if (modelFieldForDomField(pageDoc, field.index)) {
    return true;
  }

  if (field.required || field.helpText || field.options?.length) {
    return true;
  }

  if (["checkbox", "radio", "select", "select-one", "select-multiple", "textarea"].includes(String(field.type || "").toLowerCase())) {
    return true;
  }

  return Boolean(field.name && !/^q$|search/i.test(field.name));
}

function isUtilityField(field, fieldDoc) {
  const label = normaliseHumanLabel(fieldDoc.label || field.label || field.name);
  const name = normaliseHumanLabel(field.name);
  const utilityLabels = new Set([
    "p",
    "search",
    "jump to",
    "rich text editor",
    "rxcompositioncutter0",
    "rxcompositioncutter1",
    "rxcompositioncutter2",
    "rxcompositioncutter3",
  ]);

  if (utilityLabels.has(label) || utilityLabels.has(name)) {
    return true;
  }

  if ((label === "select" || name === "select") && isPaginationSelect(field)) {
    return true;
  }

  return ["button", "submit", "reset", "search"].includes(String(field.type || "").toLowerCase())
    || field.name === "search"
    || field.name === "q";
}

function isPaginationSelect(field) {
  const labels = (field.options || [])
    .map((option) => normaliseHumanLabel(option.label))
    .filter(Boolean)
    .filter((label) => label !== "..." && label !== "…");

  return labels.length > 0 && labels.every((label) => /^\d+$/.test(label));
}

function normaliseHumanLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function repeatedFieldKey(name) {
  const match = /^([a-z0-9_]+)\[[^\]]+\]\[([^\]]+)\]/i.exec(String(name || ""));

  return match ? `${match[1]}[*][${match[2]}]` : "";
}

function humanNameFromFieldName(name) {
  const repeatMatch = /^([a-z0-9_]+)\[[^\]]+\]\[([^\]]+)\]/i.exec(String(name || ""));
  const source = repeatMatch ? repeatMatch[2] : name;

  return titleCaseWords(String(source || "field").replace(/[_-]+/g, " "));
}

function titleCaseWords(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .replace(/\bUk\b/g, "UK")
    .replace(/\bEu\b/g, "EU")
    .replace(/\bUs\b/g, "US")
    .replace(/\bUrl\b/g, "URL")
    .replace(/\bSku\b/g, "SKU")
    .replace(/\bId\b/g, "ID");
}

function displayFieldLabel(fieldDoc, field = null) {
  if (repeatedFieldKey(field?.name)) {
    return humanNameFromFieldName(field.name);
  }

  return String(fieldDoc.label || "")
    .replace(/\s+optional$/i, " (optional)")
    .trim();
}

function modelFieldForDomField(pageDoc, fieldIndex) {
  return pageDoc.codeContext?.fieldMatches?.find((item) => item.fieldIndex === fieldIndex)?.modelField || null;
}

function groupFieldDocsByForm(pageDoc, fieldDocs) {
  const fieldsByIndex = new Map(pageDoc.extracted.fields.map((field) => [field.index, field]));
  const groups = new Map();

  for (const fieldDoc of fieldDocs) {
    const field = fieldsByIndex.get(fieldDoc.index);
    const title = field?.form || pageDoc.codeContext?.controller?.title || pageDoc.title || "Settings";

    if (!groups.has(title)) {
      groups.set(title, {
        title,
        fields: [],
      });
    }

    groups.get(title).fields.push(fieldDoc);
  }

  return [...groups.values()];
}

function shouldInlineFieldScreenshot(index, groupSize) {
  const maxInline = Number(config.humanDocs?.maxInlineFieldScreenshots || 8);

  return groupSize <= maxInline || index < maxInline;
}

function shouldShowValidation(validation) {
  return Boolean(validation && !/^no required marker detected\.?$/i.test(String(validation).trim()));
}

function shouldShowEffect(effect) {
  const text = markdownText(effect);

  return Boolean(text && !/^no effect was inferred\.?$/i.test(text) && !/^updates?\b/i.test(text));
}

function formatOptions(options) {
  const labels = options
    .map((option) => markdownText(option.label))
    .filter(Boolean)
    .filter((label) => !/^select/i.test(label));
  const uniqueLabels = [...new Set(labels)];
  const visibleLabels = uniqueLabels.slice(0, Number(config.humanDocs?.maxVisibleOptions || 12));
  const remaining = uniqueLabels.length - visibleLabels.length;

  if (remaining > 0) {
    return `${visibleLabels.join(", ")}, and ${remaining} more`;
  }

  return visibleLabels.join(", ");
}

function listingExampleTable(extracted) {
  const table = (extracted.tables || []).find((item) => item.headers?.length && item.rows?.length);

  if (!table) {
    return null;
  }

  const columns = table.headers
    .map((header, index) => ({
      header: markdownText(header),
      index,
    }))
    .filter((column) => column.header && !/^actions?$/i.test(column.header))
    .slice(0, 6);

  if (!columns.length) {
    return null;
  }

  const rows = (table.rows || [])
    .map((row) => columns.map((column) => maskListingExampleCell(column.header, row[column.index] || "")))
    .filter((row) => row.some(Boolean))
    .slice(0, 3);

  if (!rows.length) {
    return null;
  }

  return {
    headers: columns.map((column) => column.header),
    rows,
  };
}

function maskListingExampleCell(header, value) {
  const text = markdownText(value);

  if (!text) {
    return "";
  }

  if (isSensitiveListingHeader(header)) {
    return "[hidden]";
  }

  return text;
}

function isSensitiveListingHeader(header) {
  return /\b(token|refresh token|access token|secret|password|api key|bearer|authorization|auth header|session|cookie)\b/i.test(markdownText(header));
}

function shouldShowListingExample(workflow) {
  return /^review\b/i.test(markdownText(workflow.title));
}

function markdownTableLines(headers, rows) {
  return [
    `| ${headers.map(markdownTableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${headers.map((_, index) => markdownTableCell(row[index])).join(" | ")} |`),
  ];
}

function markdownTableCell(value) {
  return markdownText(value)
    .replace(/\|/g, "\\|")
    .slice(0, 90);
}

function writePageMarkdown(pageDoc) {
  const fieldScreensByIndex = new Map(pageDoc.fieldScreenshots.map((shot) => [shot.fieldIndex, shot]));
  const fieldsByIndex = new Map(pageDoc.extracted.fields.map((field) => [field.index, field]));
  const mainScreenshot = pageDoc.screenshots.find((screenshot) => !screenshot.error) || pageDoc.screenshots[0];
  const humanFields = selectHumanFieldDocs(pageDoc);
  const hiddenFieldCount = Math.max(0, pageDoc.analysis.fieldDocs.length - humanFields.length);
  const lines = [];

  lines.push(`# ${markdownText(pageDoc.title)}`);
  lines.push("");
  lines.push(`[Home](../../index.md) / ${markdownText(featurePageIndexTitle(pageDoc))}`);
  lines.push("");
  lines.push(`URL: ${markdownUrl(publicPageUrl(pageDoc.url))}`);
  lines.push("");
  lines.push(markdownText(pageDoc.analysis.purpose));
  lines.push("");

  if (mainScreenshot?.relativeFile) {
    lines.push(`![${markdownAlt(`${pageDoc.title} overview`)}](${mainScreenshot.relativeFile})`);
    lines.push("");
    lines.push(`*${markdownText(pageDoc.title)} page overview*`);
    lines.push("");
  }

  if (pageDoc.relatedPages?.length) {
    lines.push("## Related Pages");
    lines.push("");
    pageDoc.relatedPages.forEach((relatedPage) => {
      lines.push(`- [${markdownText(featurePageIndexTitle(relatedPage))}](${relativeTo(pageDoc.pageDir, relatedPage.docFile)}): ${markdownText(featurePageSummary(relatedPage))}`);
    });
    lines.push("");
  }

  if (pageDoc.analysis.contextNotes.length) {
    lines.push("## How It Works");
    lines.push("");
    pageDoc.analysis.contextNotes.forEach((note) => {
      lines.push(`- ${markdownText(note)}`);
    });
    lines.push("");
  }

  if (config.humanDocs?.includePageDetails) {
    lines.push("## Page Details");
    lines.push("");
    lines.push(`- URL: ${pageDoc.url}`);
    lines.push(`- Generated: ${runStartedAt.toISOString()}`);
    lines.push("");
  }

  if (pageDoc.analysis.howToUse.length) {
    lines.push("## Using This Page");
    lines.push("");
    pageDoc.analysis.howToUse.forEach((step, index) => {
      lines.push(`${index + 1}. ${markdownText(step)}`);
    });
    lines.push("");
  }

  if (pageDoc.analysis.workflows.length) {
    lines.push("## What You Can Do");
    lines.push("");
    pageDoc.analysis.workflows.forEach((workflow) => {
      lines.push(`### ${markdownText(workflow.title)}`);
      lines.push("");
      lines.push(markdownText(workflow.body));

      if (workflow.items?.length) {
        lines.push("");
        workflow.items.forEach((item) => {
          lines.push(`- ${markdownText(item)}`);
        });
      }

      const exampleTable = shouldShowListingExample(workflow) ? listingExampleTable(pageDoc.extracted) : null;

      if (exampleTable) {
        lines.push("");
        lines.push("Example rows:");
        lines.push("");
        lines.push(...markdownTableLines(exampleTable.headers, exampleTable.rows));
      }

      lines.push("");
    });
  }

  if (humanFields.length) {
    lines.push("## Key Settings");
    lines.push("");

    if (hiddenFieldCount > 0) {
      lines.push("The sections below highlight the settings people are most likely to change.");
      lines.push("");
    }

    for (const group of groupFieldDocsByForm(pageDoc, humanFields)) {
      lines.push(`### ${markdownText(group.title)}`);
      lines.push("");

      group.fields.forEach((fieldDoc, index) => {
        const field = fieldsByIndex.get(fieldDoc.index) || {};
        const shot = fieldScreensByIndex.get(fieldDoc.index);
        const modelField = modelFieldForDomField(pageDoc, fieldDoc.index);
        const label = displayFieldLabel(fieldDoc, field);
        lines.push(`#### ${markdownText(label)}`);
        lines.push("");

        if (shot?.relativeFile && shouldInlineFieldScreenshot(index, group.fields.length)) {
          lines.push(`![${markdownAlt(label)}](${shot.relativeFile})`);
          lines.push("");
          lines.push(`*${markdownText(label)} setting*`);
          lines.push("");
        }

        lines.push(markdownText(fieldDoc.howToUse));

        if (shouldShowEffect(fieldDoc.effects)) {
          lines.push("");
          lines.push(`**Effect:** ${markdownText(fieldDoc.effects)}`);
        }

        if (shouldShowValidation(fieldDoc.validation)) {
          lines.push("");
          lines.push(`**Validation:** ${markdownText(fieldDoc.validation)}`);
        }

        if (field.options?.length) {
          lines.push("");
          lines.push(`**Options:** ${formatOptions(field.options)}`);
        }

        if (config.humanDocs?.includeFieldTechnicalDetails && modelField?.dbname) {
          lines.push("");
          lines.push(`**Stored as:** \`${markdownCode(modelField.dbname)}\`${modelField.type ? ` (${markdownText(modelField.type)})` : ""}`);
        } else if (config.humanDocs?.includeFieldTechnicalDetails && field.name) {
          lines.push("");
          lines.push(`**Submitted as:** \`${markdownCode(field.name)}\``);
        }

        if (fieldDoc.notes) {
          lines.push("");
          lines.push(`**Notes:** ${markdownText(fieldDoc.notes)}`);
        }

        lines.push("");
      });
    }
  }

  if (pageDoc.analysis.primaryActions.length) {
    lines.push("## Available Actions");
    lines.push("");
    pageDoc.analysis.primaryActions.forEach((action) => {
      lines.push(`- ${markdownText(action)}`);
    });
    lines.push("");
  }

  if (config.humanDocs?.includeTechnicalReferences && pageDoc.analysis.sideEffects.length) {
    lines.push("## Behaviour To Confirm");
    lines.push("");
    pageDoc.analysis.sideEffects.forEach((effect) => {
      lines.push(`- ${markdownText(effect)}`);
    });
    lines.push("");
  }

  if (config.humanDocs?.includeTechnicalReferences && pageDoc.codeContext?.enabled) {
    lines.push("## Technical References");
    lines.push("");

    if (pageDoc.codeContext.controller) {
      lines.push(`- Controller: \`${markdownCode(pageDoc.codeContext.controller.className)}\` via \`${markdownCode(pageDoc.codeContext.controller.alias)}\``);
      lines.push(`- Action: \`${markdownCode(pageDoc.codeContext.controller.actionMethod)}\`${pageDoc.codeContext.controller.hasActionMethod ? "" : " (inherited or not found locally)"}`);

      if (pageDoc.codeContext.controller.file) {
        lines.push(`- Controller file: \`${markdownCode(relativeTo(repoRoot, pageDoc.codeContext.controller.file))}\``);
      }
    } else {
      lines.push("- Controller: not resolved from provider aliases.");
    }

    if (pageDoc.codeContext.model?.alias) {
      lines.push(`- Model: \`${markdownCode(pageDoc.codeContext.model.alias)}\` => \`${markdownCode(pageDoc.codeContext.model.className || "unresolved")}\``);

      if (pageDoc.codeContext.model.file) {
        lines.push(`- Model file: \`${markdownCode(relativeTo(repoRoot, pageDoc.codeContext.model.file))}\``);
      }

      if (pageDoc.codeContext.model.xmlFile) {
        lines.push(`- Model XML: \`${markdownCode(relativeTo(repoRoot, pageDoc.codeContext.model.xmlFile))}\``);
      }

      if (pageDoc.codeContext.model.itemName) {
        lines.push(`- Model item prefix: \`${markdownCode(pageDoc.codeContext.model.itemName)}\``);
      }
    }
    lines.push("");
  }

  if (config.humanDocs?.includeFieldReference && pageDoc.analysis.fieldDocs.length) {
    lines.push("## Field Reference");
    lines.push("");
    lines.push("| Field | Notes |");
    lines.push("| --- | --- |");
    pageDoc.analysis.fieldDocs.forEach((fieldDoc) => {
      const field = fieldsByIndex.get(fieldDoc.index) || {};
      const label = displayFieldLabel(fieldDoc, field);
      const notes = [
        field.required ? "Required" : "",
        field.helpText || "",
      ].filter(Boolean).join("; ");

      lines.push(`| ${markdownTableText(label)} | ${markdownTableText(notes)} |`);
    });
    lines.push("");
  }

  const extraScreenshots = pageDoc.screenshots.filter((screenshot) => screenshot !== mainScreenshot);

  if (extraScreenshots.length) {
    lines.push("## Additional Screenshots");
    lines.push("");
    extraScreenshots.forEach((screenshot) => {
      lines.push(`### ${markdownText(screenshot.viewport)}`);
      lines.push("");
      lines.push(`![${markdownAlt(`${pageDoc.title} ${screenshot.viewport}`)}](${screenshot.relativeFile})`);
      lines.push("");
    });
  }

  if (config.humanDocs?.includeReviewNotes && pageDoc.analysis.unansweredQuestions.length) {
    lines.push("## Review Notes");
    lines.push("");
    pageDoc.analysis.unansweredQuestions.forEach((question) => {
      lines.push(`- ${markdownText(question)}`);
    });
    lines.push("");
  }

  if (pageDoc.technicalError) {
    lines.push("## Capture Error");
    lines.push("");
    lines.push(markdownText(pageDoc.technicalError));
    lines.push("");
  }

  writeFileSync(pageDoc.docFile, `${lines.join("\n").trim()}\n`);
}

function writeIndex(pages) {
  const overview = buildFeatureOverview(pages);

  if (isCollectionIndex(overview, pages)) {
    writeCollectionIndex(pages, overview);
    return;
  }

  const lines = [];
  const mainScreenshot = overview.screenshot;

  lines.push(`# ${markdownText(overview.title)}`);
  lines.push("");
  lines.push(markdownText(overview.intro));
  lines.push("");

  if (mainScreenshot?.file) {
    lines.push(`![${markdownAlt(`${overview.title} overview`)}](${relativeTo(runDir, mainScreenshot.file)})`);
    lines.push("");
    lines.push(`*${markdownText(overview.title)} overview*`);
    lines.push("");
  }

  if (overview.capabilities.length) {
    lines.push("## What This Feature Does");
    lines.push("");
    overview.capabilities.forEach((capability) => {
      lines.push(`- ${markdownText(capability)}`);
    });
    lines.push("");
  }

  if (overview.settings.length) {
    lines.push("## Key Settings");
    lines.push("");
    overview.settings.forEach((setting) => {
      lines.push(`- **${markdownText(setting.label)}:** ${markdownText(setting.summary)}`);
    });
    lines.push("");
  }

  lines.push("## Screens Covered");
  lines.push("");

  pages.forEach((pageDoc, index) => {
    lines.push(`${index + 1}. [${markdownText(featurePageIndexTitle(pageDoc))}](${relativeTo(runDir, pageDoc.docFile)}) - ${markdownText(featurePageSummary(pageDoc))}`);
    lines.push(`   URL: ${markdownUrl(publicPageUrl(pageDoc.url))}`);
  });

  writeFileSync(path.join(runDir, "index.md"), `${lines.join("\n").trim()}\n`);
}

function isCollectionIndex(overview, pages) {
  return pages.length > 1 && overview.title === `${config.siteName} Feature Documentation`;
}

function writeCollectionIndex(pages, overview) {
  const title = `${config.siteName} Documentation`;
  const indexPages = collectionIndexPages(pages);
  const lines = [];

  lines.push(`# ${markdownText(title)}`);
  lines.push("");
  lines.push(collectionIntro());
  lines.push("");
  lines.push("## What Each Page Includes");
  lines.push("");
  lines.push("- A direct URL for the live CP screen.");
  lines.push("- A redacted page screenshot for orientation.");
  lines.push("- A short explanation of what the feature is for.");
  lines.push("- Main workflows, important fields, and example listing rows where they help explain the feature.");
  lines.push("");
  lines.push("## Features Covered");
  lines.push("");

  indexPages.forEach((pageDoc, index) => {
    lines.push(`${index + 1}. **[${markdownText(featurePageIndexTitle(pageDoc))}](${relativeTo(runDir, pageDoc.docFile)})**: ${markdownText(collectionPageDescription(pageDoc))}`);
    lines.push(`   URL: ${markdownUrl(publicPageUrl(pageDoc.url))}`);
  });

  writeFileSync(path.join(runDir, "index.md"), `${lines.join("\n").trim()}\n`);
}

function collectionIntro() {
  const scope = config.siteName || "this site";

  return `A practical guide to the ${scope} features captured so far.`;
}

function collectionIndexPages(pages) {
  const topLevelPages = pages.filter((pageDoc) => !isCollectionChildPage(pageDoc));

  return topLevelPages.length ? topLevelPages : pages;
}

function isCollectionChildPage(pageDoc) {
  return relatedPageWeight(pageDoc) > 0
    && (pageDoc.relatedPages || []).some((relatedPage) => relatedPageWeight(relatedPage) === 0);
}

function collectionPageDescription(pageDoc) {
  return cleanCollectionDescription(pageDoc.codeContext?.featureSummary?.description)
    || cleanCollectionDescription(pageDoc.analysis?.purpose)
    || fallbackCollectionDescription(pageDoc);
}

function cleanCollectionDescription(value) {
  const text = markdownText(value);

  if (!text) {
    return "";
  }

  if (/^(start here|use create new|open an existing|this screen gives admins|review\b)/i.test(text)) {
    return "";
  }

  return text;
}

function fallbackCollectionDescription(pageDoc) {
  const title = markdownText(pageDoc.title);
  const featureName = sentenceFeatureName(title);

  if ((pageDoc.extracted?.tables || []).length) {
    return `${title} provides the admin list and record actions for ${featureName}.`;
  }

  if ((pageDoc.extracted?.forms || []).length) {
    return `${title} contains the admin settings used to maintain ${featureName}.`;
  }

  return `${title} documents the admin controls for ${featureName}.`;
}

function writeCodeDocs(pages) {
  if (config.codeDocs?.enabled === false) {
    return;
  }

  const pagesWithContext = pages.filter((pageDoc) => hasCodeDocContext(pageDoc));

  if (!pagesWithContext.length) {
    return;
  }

  mkdirSync(codeDocsRoot, { recursive: true });

  const usedFiles = new Set();
  const docs = pagesWithContext.map((pageDoc) => {
    const file = uniqueCodeDocFile(pageDoc, usedFiles);
    pageDoc.codeDocFile = file;
    writeCodeDocFile(pageDoc, file);

    return {
      pageDoc,
      file,
      title: featurePageIndexTitle(pageDoc),
    };
  });

  writeCodeDocsIndex(docs);
}

function hasCodeDocContext(pageDoc) {
  const context = pageDoc.codeContext;

  return Boolean(context?.enabled && (
    context.featureSummary?.description
    || context.featureSummary?.notes?.length
    || context.controller?.file
    || context.model?.file
    || context.model?.xmlFile
    || context.references?.length
  ));
}

function uniqueCodeDocFile(pageDoc, usedFiles) {
  const base = codeDocSlug(pageDoc) || "page";
  let file = path.join(codeDocsRoot, `${base}.md`);
  let suffix = 2;

  while (usedFiles.has(file)) {
    file = path.join(codeDocsRoot, `${base}-${suffix}.md`);
    suffix += 1;
  }

  usedFiles.add(file);

  return file;
}

function codeDocSlug(pageDoc) {
  const route = pageDoc.codeContext?.route || {};
  const parts = [];

  if (route.cp) {
    parts.push("cp");
  }

  if (route.controllerAlias) {
    parts.push(route.controllerAlias);
  } else {
    parts.push(new URL(pageDoc.url).pathname);
  }

  if (route.action && route.action !== "index") {
    parts.push(route.action);
  }

  const screenKey = codeDocScreenKey(pageDoc);

  if (screenKey) {
    parts.push(screenKey);
  }

  return slug(parts.join("-"));
}

function codeDocScreenKey(pageDoc) {
  const pathname = new URL(pageDoc.url).pathname;

  if (/\/edit\/new\/?$/i.test(pathname)) {
    return "new";
  }

  if (/\/edit\/[^/]+\/?$/i.test(pathname)) {
    return "existing";
  }

  if (/\/view\/[^/]+\/?$/i.test(pathname)) {
    return "view";
  }

  return "";
}

function writeCodeDocFile(pageDoc, file) {
  const context = pageDoc.codeContext || {};
  const title = featurePageIndexTitle(pageDoc);
  const summary = context.featureSummary?.description || pageDoc.analysis?.purpose || featurePageSummary(pageDoc);
  const notes = codeDocNotes(pageDoc);
  const fields = codeDocFieldSummaries(pageDoc);
  const behaviours = codeDocBehaviourSummaries(pageDoc);
  const references = codeDocReferences(pageDoc);
  const lines = [];

  lines.push(`# ${markdownText(title)} Code Notes`);
  lines.push("");
  lines.push("Use this as orientation before changing the feature. Verify the behaviour against the source files listed below.");
  lines.push("");
  lines.push(`- Feature URL: ${markdownUrl(publicPageUrl(pageDoc.url))}`);
  lines.push(`- Captured URL: ${markdownUrl(pageDoc.url)}`);
  lines.push(`- Generated feature docs: [${markdownText(relativeTo(repoRoot, pageDoc.docFile))}](${relativeTo(path.dirname(file), pageDoc.docFile)})`);

  if (context.route?.controllerAlias) {
    lines.push(`- Route: \`${markdownCode(context.route.controllerAlias)}\`${context.route.action ? ` / \`${markdownCode(context.route.action)}\`` : ""}`);
  }

  lines.push("");
  lines.push("## What It Does");
  lines.push("");
  lines.push(markdownText(summary) || "The generator found source references for this screen, but it could not infer a concise feature summary yet.");
  lines.push("");

  if (notes.length) {
    lines.push("## How It Works");
    lines.push("");
    notes.forEach((note) => {
      lines.push(`- ${markdownText(note)}`);
    });
    lines.push("");
  }

  if (fields.length) {
    lines.push("## Important Fields");
    lines.push("");
    lines.push("| Field | Purpose | Source |");
    lines.push("| --- | --- | --- |");
    fields.forEach((field) => {
      lines.push(`| ${markdownTableText(field.label)} | ${markdownTableText(field.summary)} | ${markdownTableText(field.source)} |`);
    });
    lines.push("");
  }

  if (behaviours.length) {
    lines.push("## Behaviour In Code");
    lines.push("");
    behaviours.forEach((behaviour) => {
      lines.push(`- ${markdownText(behaviour)}`);
    });
    lines.push("");
  }

  if (references.length) {
    lines.push("## Source References");
    lines.push("");
    references.forEach((reference) => {
      lines.push(`- ${markdownText(reference.label)}: ${markdownSourceLink(file, reference.file)}`);
    });
    lines.push("");
  }

  lines.push("## Notes For Future Agents");
  lines.push("");
  lines.push("- Use this file to get the feature shape before editing.");
  lines.push("- Re-read the source references before making code changes, because this file is generated context rather than the source of truth.");
  lines.push("- If the feature behaviour changes, regenerate Feature Docs so this reference stays useful.");

  writeFileSync(file, `${lines.join("\n").trim()}\n`);
}

function writeCodeDocsIndex(docs) {
  const lines = [];
  const entries = codeDocIndexEntries(docs);

  lines.push("# Code Docs");
  lines.push("");
  lines.push("Generated code-analysis notes from Feature Docs. These files are for developers and AI agents: use them to understand a feature quickly, then verify details in the referenced source files.");
  lines.push("");
  lines.push("## Features");
  lines.push("");

  entries
    .sort((a, b) => a.title.localeCompare(b.title))
    .forEach((entry) => {
      const description = entry.description ? ` - ${markdownText(entry.description)}` : "";
      const url = entry.url ? ` URL: ${markdownUrl(entry.url)}` : "";
      lines.push(`- [${markdownText(entry.title)}](${relativeTo(codeDocsRoot, entry.file)})${description}${url}`);
    });

  writeFileSync(path.join(codeDocsRoot, "index.md"), `${lines.join("\n").trim()}\n`);
}

function codeDocIndexEntries(currentDocs) {
  const currentByFile = new Map(currentDocs.map((doc) => [
    path.resolve(doc.file),
    {
      file: doc.file,
      title: doc.title,
      description: doc.pageDoc.codeContext?.featureSummary?.description || featurePageSummary(doc.pageDoc),
      url: publicPageUrl(doc.pageDoc.url),
    },
  ]));

  return readdirSync(codeDocsRoot)
    .filter((fileName) => /\.md$/i.test(fileName))
    .filter((fileName) => !/^(README|index)\.md$/i.test(fileName))
    .map((fileName) => path.resolve(codeDocsRoot, fileName))
    .map((file) => currentByFile.get(file) || readCodeDocIndexEntry(file))
    .filter(Boolean);
}

function readCodeDocIndexEntry(file) {
  const content = readFileSync(file, "utf8");
  const title = markdownText(content.match(/^#\s+(.+?)\s*(?:Code Notes)?$/m)?.[1])
    || titleCaseWords(path.basename(file, ".md").replace(/[-_]+/g, " "));
  const description = markdownText(content.match(/## What It Does\s+([\s\S]*?)(?:\n## |\n$)/)?.[1] || "")
    .split("\n")
    .map(markdownText)
    .find(Boolean) || "";
  const url = markdownText(content.match(/^- Feature URL:\s+\[([^\]]+)\]\([^)]+\)/m)?.[1] || "");

  return {
    file,
    title,
    description,
    url,
  };
}

function codeDocNotes(pageDoc) {
  return uniqueMarkdownLines([
    ...(pageDoc.codeContext?.featureSummary?.notes || []),
    ...(pageDoc.analysis?.contextNotes || []),
  ]).slice(0, 12);
}

function codeDocFieldSummaries(pageDoc) {
  const fieldsByIndex = new Map(pageDoc.extracted.fields.map((field) => [field.index, field]));
  const domFieldSummaries = selectHumanFieldDocs(pageDoc)
    .map((fieldDoc) => {
      const field = fieldsByIndex.get(fieldDoc.index) || {};
      const modelField = modelFieldForDomField(pageDoc, fieldDoc.index);
      const label = displayFieldLabel(fieldDoc, field);
      const summary = inferFeatureSettingSummary(pageDoc.title, label, fieldDoc)
        || cleanFeatureSummaryText(fieldDoc.notes)
        || cleanFeatureSummaryText(fieldDoc.howToUse)
        || cleanFeatureSummaryText(fieldDoc.validation);

      if (!label || !summary) {
        return null;
      }

      return {
        label,
        summary,
        source: modelField ? `${modelField.name || modelField.dbname || "field"}${modelField.type ? ` (${modelField.type})` : ""}` : "DOM field",
      };
    })
    .filter(Boolean);

  if (domFieldSummaries.length) {
    return domFieldSummaries.slice(0, 20);
  }

  return codeDocModelFieldSummaries(pageDoc).slice(0, 20);
}

function codeDocModelFieldSummaries(pageDoc) {
  return (pageDoc.codeContext?.model?.fields || [])
    .filter((field) => !/^(created|updated)$/i.test(field.name || field.dbname || ""))
    .map((fieldDoc) => {
      const label = fieldDoc.name || humanNameFromFieldName(fieldDoc.dbname || "");
      const summary = codeDocModelFieldSummary(pageDoc, label, fieldDoc);

      if (!label || !summary) {
        return null;
      }

      return {
        label,
        summary,
        source: `${fieldDoc.dbname || fieldDoc.name || "field"}${fieldDoc.type ? ` (${fieldDoc.type})` : ""}`,
      };
    })
    .filter(Boolean);
}

function codeDocModelFieldSummary(pageDoc, label, fieldDoc) {
  const description = markdownText(fieldDoc.description);

  if (description) {
    return description;
  }

  const normalised = normaliseHumanLabel(label);
  const itemName = sentenceFeatureName(singularFeatureName(pageDoc.title));

  if (normalised === "name") {
    return `Identifies the ${itemName} in the admin listing.`;
  }

  if (normalised === "status") {
    return `Shows whether the ${itemName} can currently be used.`;
  }

  if (normalised === "environment") {
    return `Limits the ${itemName} to the matching site environment.`;
  }

  if (normalised === "services") {
    return `Controls which webhook services the ${itemName} can access.`;
  }

  if (normalised.includes("last accessed")) {
    return `Shows when the ${itemName} was last used successfully.`;
  }

  return `Records the ${sentenceFeatureName(label)} for this ${itemName}.`;
}

function codeDocBehaviourSummaries(pageDoc) {
  const context = pageDoc.codeContext || {};
  const methods = [
    ...(context.controller?.methodSummaries || []),
    ...(context.model?.methodSummaries || []),
    ...referenceMethodSummaries(context.references || []),
  ];
  const actionTexts = [
    ...(context.controller?.actionTexts || []),
    ...(context.model?.actionTexts || []),
  ]
    .map(markdownText)
    .filter((text) => text && !/^are you sure\b/i.test(text))
    .map((text) => `Action available in the admin UI: ${text}.`);
  const methodLines = methods
    .map(codeDocMethodSummary)
    .filter(Boolean);

  return uniqueMarkdownLines([
    ...methodLines,
    ...actionTexts,
  ]).slice(0, 12);
}

function codeDocMethodSummary(method) {
  const name = markdownText(method.name);
  const summary = markdownText(method.summary);

  if (!name || !summary || isThinCodeSummary(summary)) {
    return "";
  }

  if (/^registerServices$/i.test(name) && /container/i.test(summary)) {
    return "";
  }

  if (summary.length > 220 || /\bclass\s+\w+|\/\*\*|@var|protected\s+\$/i.test(summary)) {
    return "";
  }

  if (/^(index|edit|view|save|delete|remove)Action$/i.test(name)) {
    return `${actionTitle(name.replace(/Action$/i, ""))}: ${ensureSentence(summary)}`;
  }

  if (!/token|access|allow|status|environment|service|validate|create|refresh|revoke|permission|discount|export|import|sync|send|calculate|apply/i.test(`${name} ${summary}`)) {
    return "";
  }

  return `${actionTitle(name)}: ${ensureSentence(summary)}`;
}

function ensureSentence(value) {
  const text = markdownText(value);

  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function codeDocReferences(pageDoc) {
  const context = pageDoc.codeContext || {};
  const references = [
    { label: "Controller", file: context.controller?.file },
    { label: "Model", file: context.model?.file },
    { label: "Model XML", file: context.model?.xmlFile },
    ...(context.references || []).map((reference) => ({
      label: titleCaseWords(String(reference.type || "source").replace(/[-_]+/g, " ")),
      file: reference.file,
    })),
  ];
  const seen = new Set();

  return references.filter((reference) => {
    if (!reference.file || seen.has(reference.file)) {
      return false;
    }

    seen.add(reference.file);

    return true;
  });
}

function markdownSourceLink(fromFile, targetFile) {
  const repoPath = relativeTo(repoRoot, targetFile);
  const link = relativeTo(path.dirname(fromFile), targetFile).replace(/\)/g, "%29");

  return `[${markdownText(repoPath)}](${link})`;
}

function uniqueMarkdownLines(values) {
  const seen = new Set();
  const lines = [];

  values.map(markdownText).filter(Boolean).forEach((value) => {
    const key = value.toLowerCase();

    if (!seen.has(key)) {
      seen.add(key);
      lines.push(value);
    }
  });

  return lines;
}

function buildFeatureOverview(pages) {
  const title = inferFeatureTitle(pages);

  return {
    title,
    intro: inferFeatureIntro(title, pages),
    capabilities: inferFeatureCapabilities(title, pages),
    settings: inferFeatureSettings(title, pages),
    screenshot: pages.flatMap((pageDoc) => pageDoc.screenshots || []).find((screenshot) => screenshot.file && !screenshot.error),
  };
}

function inferFeatureTitle(pages) {
  const titles = pages
    .map((pageDoc) => pageDoc.title)
    .filter(Boolean)
    .filter((title) => !isNoisyCpTitle(title));

  if (!titles.length) {
    return `${config.siteName} Feature Documentation`;
  }

  const counts = new Map();

  titles.forEach((title) => {
    counts.set(title, (counts.get(title) || 0) + 1);
  });

  const [title, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];

  if (count < 2 || count / titles.length < 0.5) {
    return `${config.siteName} Feature Documentation`;
  }

  return title;
}

function inferFeatureIntro(title, pages) {
  if (isDiscountPermissionFeature(title, pages)) {
    return "Discount Permission Settings control how much discount each admin role can apply when raising custom discounts. Each setting links a role to a percentage limit and, when needed, a fixed amount limit.";
  }

  const firstPurpose = pages.find((pageDoc) => pageDoc.analysis?.purpose)?.analysis?.purpose;
  const codeDescription = pages.map((pageDoc) => pageDoc.codeContext?.featureSummary?.description).find(Boolean);
  const featureName = sentenceFeatureName(title);
  const itemName = sentenceFeatureName(singularFeatureName(title));
  const hasTables = pages.some((pageDoc) => (pageDoc.extracted.tables || []).length);
  const hasForms = pages.some((pageDoc) => pageDoc.extracted.forms.length);

  if (codeDescription) {
    return codeDescription;
  }

  if (hasTables && hasForms) {
    return `${title} is where admins review existing ${featureName} and maintain the details behind each ${itemName}. The screens below show the usual path: find the right ${itemName}, create one if it does not exist, or open an existing one to update its fields.`;
  }

  if (hasTables) {
    return `${title} is where admins find and review existing ${featureName}. The listing fields help someone identify the right row before opening it for more detail.`;
  }

  if (hasForms) {
    return `${title} contains the fields an admin uses when they need to maintain this ${itemName}.`;
  }

  return firstPurpose || `${title} covers the admin controls used for ${featureName}.`;
}

function inferFeatureCapabilities(title, pages) {
  if (isDiscountPermissionFeature(title, pages)) {
    return [
      "Lists the custom discount limits already configured for admin roles.",
      "Lets an authorised user create a new limit for a role.",
      "Lets an authorised user edit an existing role limit.",
      "Caps percentage discounts between 0 and 100.",
      "Can also cap fixed-amount discounts; a fixed amount of 0 means there is no fixed-amount cap.",
      "If a user has more than one matching role, the role setting with the highest percentage limit is used.",
    ];
  }

  const capabilities = [];
  const seen = new Set();

  pages.forEach((pageDoc) => {
    (pageDoc.codeContext?.featureSummary?.notes || []).forEach((note) => {
      const body = markdownText(note);
      const key = body.toLowerCase();

      if (body && !seen.has(key)) {
        seen.add(key);
        capabilities.push(body);
      }
    });
  });

  pages.forEach((pageDoc) => {
    (pageDoc.analysis?.workflows || []).forEach((workflow) => {
      const body = markdownText(workflow.body);
      const key = body.toLowerCase();

      if (body && !seen.has(key)) {
        seen.add(key);
        capabilities.push(body);
      }
    });
  });

  if (!capabilities.length && pages.length) {
    capabilities.push(`Documents ${pages.length} screen${pages.length === 1 ? "" : "s"} for ${title}.`);
  }

  return capabilities.slice(0, 8);
}

function inferFeatureSettings(title, pages) {
  const settings = [];
  const seen = new Set();

  pages.forEach((pageDoc) => {
    const fieldsByIndex = new Map(pageDoc.extracted.fields.map((field) => [field.index, field]));

    selectHumanFieldDocs(pageDoc).forEach((fieldDoc) => {
      const field = fieldsByIndex.get(fieldDoc.index) || {};
      const label = displayFieldLabel(fieldDoc, field);
      const key = normaliseHumanLabel(label);

      if (!key || seen.has(key)) {
        return;
      }

      const summary = inferFeatureSettingSummary(title, label, fieldDoc);

      if (!summary) {
        return;
      }

      seen.add(key);
      settings.push({
        label,
        summary,
      });
    });
  });

  return settings.slice(0, 12);
}

function inferFeatureSettingSummary(title, label, fieldDoc) {
  const normalisedLabel = normaliseHumanLabel(label);

  if (isDiscountPermissionFeature(title)) {
    if (normalisedLabel === "role") {
      return "Selects which admin role the discount limits apply to.";
    }

    if (normalisedLabel.includes("max discount percentage")) {
      return "Sets the highest percentage discount the role can apply. Use 100 to allow the role to apply any percentage discount.";
    }

    if (normalisedLabel.includes("max discount amount")) {
      return "Sets the highest fixed amount discount the role can apply. Use 0 when the role should not have a fixed-amount cap.";
    }
  }

  const summary = [
    fieldDoc.effects,
    fieldDoc.howToUse,
    fieldDoc.notes,
  ]
    .map(cleanFeatureSummaryText)
    .find(Boolean);

  return summary || "";
}

function cleanFeatureSummaryText(value) {
  const text = markdownText(value);

  if (!text || /^no effect was inferred\.?$/i.test(text) || /^updates?\b/i.test(text)) {
    return "";
  }

  return text;
}

function featurePageIndexTitle(pageDoc) {
  const pathname = new URL(pageDoc.url).pathname;
  const itemName = singularFeatureName(pageDoc.title);
  const routeAction = pageDoc.codeContext?.route?.action || "";

  if (/\/edit\/new\/?$/i.test(pathname)) {
    return `Create ${itemName}`;
  }

  if (/\/edit\/[^/]+\/?$/i.test(pathname)) {
    return `Edit ${itemName}`;
  }

  if (/\/view\/[^/]+\/?$/i.test(pathname)) {
    return `View ${itemName}`;
  }

  if ((pageDoc.extracted.tables || []).length && routeAction && routeAction !== "index") {
    return `${pageDoc.title} ${actionTitle(routeAction)}`;
  }

  if ((pageDoc.extracted.tables || []).length) {
    return pageDoc.title;
  }

  return pageDoc.title;
}

function actionTitle(action) {
  return titleCaseWords(String(action || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " "));
}

function featurePageSummary(pageDoc) {
  const pathname = new URL(pageDoc.url).pathname;

  if (isDiscountPermissionFeature(pageDoc.title)) {
    if (/\/edit\/new\/?$/i.test(pathname)) {
      return "Add the role and discount limits for a new permission setting.";
    }

    if (/\/edit\/[^/]+\/?$/i.test(pathname)) {
      return "Update the percentage or fixed amount limit for an existing role.";
    }

    return "Review the roles that already have custom discount limits.";
  }

  const workflow = pageDoc.analysis?.workflows?.[0];

  return workflow?.body || pageDoc.analysis?.purpose || "Review the captured screen and its settings.";
}

function isDiscountPermissionFeature(title, pages = []) {
  const values = [
    title,
    ...pages.map((pageDoc) => pageDoc.title),
    ...pages.map((pageDoc) => pageDoc.codeContext?.model?.className || ""),
    ...pages.flatMap((pageDoc) => (pageDoc.extracted?.fields || []).map((field) => field.label || field.name || "")),
  ].join(" ");

  return /discount permission settings?/i.test(values)
    || /customdiscount\\model\\discountpermissionsettings/i.test(values)
    || /custom_discount_permission_settings/i.test(values);
}

function writeAgentContext(pages) {
  const lines = [];
  lines.push(`# ${markdownText(config.siteName)} Feature Docs Agent Context`);
  lines.push("");
  lines.push(`Generated: ${runStartedAt.toISOString()}`);
  lines.push("");
  lines.push("Use this file as the handoff for Codex to produce final operator documentation. Read the referenced controller, model, XML, and view files before finalising page purpose, field behaviour, validation, and side effects.");
  lines.push("");

  for (const pageDoc of pages) {
    lines.push(`## ${markdownText(pageDoc.title)}`);
    lines.push("");
    lines.push(`- URL: ${pageDoc.url}`);
    lines.push(`- Documentation route key: ${pageDoc.routeKey}`);
    lines.push(`- Draft doc: ${relativeTo(runDir, pageDoc.docFile)}`);
    if (pageDoc.codeDocFile) {
      lines.push(`- Code analysis doc: ${relativeTo(repoRoot, pageDoc.codeDocFile)}`);
    }
    lines.push(`- Page screenshots: ${pageDoc.screenshots.map((screenshot) => relativeTo(runDir, screenshot.file)).join(", ") || "none"}`);
    lines.push(`- Field count: ${pageDoc.extracted.fields.length}`);

    if (pageDoc.codeContext?.controller) {
      lines.push(`- Controller: ${pageDoc.codeContext.controller.className} (${pageDoc.codeContext.controller.alias})`);
      lines.push(`- Controller file: ${pageDoc.codeContext.controller.file ? relativeTo(repoRoot, pageDoc.codeContext.controller.file) : "unresolved"}`);
      lines.push(`- Action method: ${pageDoc.codeContext.controller.actionMethod}${pageDoc.codeContext.controller.hasActionMethod ? "" : " (inherited or unresolved)"}`);

      if (pageDoc.codeContext.route?.routePattern?.pattern) {
        lines.push(`- Matched route pattern: ${pageDoc.codeContext.route.routePattern.pattern}`);
      }
    } else {
      lines.push("- Controller: unresolved");
    }

    if (pageDoc.codeContext?.model?.alias) {
      lines.push(`- Model: ${pageDoc.codeContext.model.alias} => ${pageDoc.codeContext.model.className || "unresolved"}`);
      lines.push(`- Model file: ${pageDoc.codeContext.model.file ? relativeTo(repoRoot, pageDoc.codeContext.model.file) : "unresolved"}`);
      lines.push(`- Model XML: ${pageDoc.codeContext.model.xmlFile ? relativeTo(repoRoot, pageDoc.codeContext.model.xmlFile) : "unresolved"}`);
      lines.push(`- Model item prefix: ${pageDoc.codeContext.model.itemName || "unresolved"}`);
    }

    if (pageDoc.extracted.fields.length) {
      lines.push("");
      lines.push("### DOM Fields");
      lines.push("");

      for (const field of pageDoc.extracted.fields) {
        const match = pageDoc.codeContext?.fieldMatches?.find((item) => item.fieldIndex === field.index);
        const modelField = match?.modelField;
        lines.push(`- ${field.index}. ${markdownText(field.label || field.name || "Unnamed field")} (${markdownText(field.type || field.tag)})`);

        if (field.name) {
          lines.push(`  - DOM name: \`${markdownCode(field.name)}\``);
        }

        if (modelField) {
          lines.push(`  - Model field: ${markdownText(modelField.name || modelField.dbname)} / \`${markdownCode(modelField.dbname || "")}\` / ${markdownText(modelField.type || "")}`);
        }

        const shot = pageDoc.fieldScreenshots.find((item) => item.fieldIndex === field.index);

        if (shot?.file) {
          lines.push(`  - Screenshot: ${relativeTo(runDir, shot.file)}`);
        }
      }
    }

    if (pageDoc.codeContext?.references?.length) {
      lines.push("");
      lines.push("### Source References");
      lines.push("");
      pageDoc.codeContext.references.forEach((item) => {
        lines.push(`- ${item.type}: ${relativeTo(repoRoot, item.file)}`);
      });
    }

    lines.push("");
  }

  writeFileSync(path.join(runDir, "agent-context.md"), `${lines.join("\n").trim()}\n`);
}

function writeSummary(pages) {
  const summary = {
    siteName: config.siteName,
    generatedAt: runStartedAt.toISOString(),
    runDir,
    pageCount: pages.length,
    crawl: {
      skippedDuplicateRoutes: crawlStats.skippedDuplicateRoutes,
      skippedDisallowedUrls: crawlStats.skippedDisallowedUrls,
    },
    pages: pages.map((pageDoc) => ({
      title: pageDoc.title,
      indexTitle: featurePageIndexTitle(pageDoc),
      description: collectionPageDescription(pageDoc),
      url: pageDoc.url,
      publicUrl: publicPageUrl(pageDoc.url),
      routeKey: pageDoc.routeKey,
      routeMetadata: pageDoc.routeMetadata || null,
      slug: pageDoc.slug,
      docFile: relativeTo(runDir, pageDoc.docFile),
      codeDocFile: pageDoc.codeDocFile ? relativeTo(repoRoot, pageDoc.codeDocFile) : "",
      relatedPages: (pageDoc.relatedPages || []).map((relatedPage) => ({
        title: featurePageIndexTitle(relatedPage),
        docFile: relativeTo(runDir, relatedPage.docFile),
        url: relatedPage.url,
        publicUrl: publicPageUrl(relatedPage.url),
      })),
      screenshots: pageDoc.screenshots.map((screenshot) => relativeTo(runDir, screenshot.file)),
      fieldScreenshots: pageDoc.fieldScreenshots.filter((shot) => shot.file).map((shot) => relativeTo(runDir, shot.file)),
      fieldCount: pageDoc.extracted.fields.length,
      codeContext: {
        route: pageDoc.codeContext?.route ? {
          controllerAlias: pageDoc.codeContext.route.controllerAlias || "",
          action: pageDoc.codeContext.route.action || "",
          pattern: pageDoc.codeContext.route.routePattern?.pattern || "",
        } : null,
        controller: pageDoc.codeContext?.controller ? {
          alias: pageDoc.codeContext.controller.alias,
          className: pageDoc.codeContext.controller.className,
          file: pageDoc.codeContext.controller.file ? relativeTo(repoRoot, pageDoc.codeContext.controller.file) : "",
          actionMethod: pageDoc.codeContext.controller.actionMethod,
          hasActionMethod: pageDoc.codeContext.controller.hasActionMethod,
        } : null,
        model: pageDoc.codeContext?.model ? {
          alias: pageDoc.codeContext.model.alias,
          className: pageDoc.codeContext.model.className,
          file: pageDoc.codeContext.model.file ? relativeTo(repoRoot, pageDoc.codeContext.model.file) : "",
          xmlFile: pageDoc.codeContext.model.xmlFile ? relativeTo(repoRoot, pageDoc.codeContext.model.xmlFile) : "",
          itemName: pageDoc.codeContext.model.itemName || "",
          tableName: pageDoc.codeContext.model.tableName || "",
        } : null,
        featureSummary: pageDoc.codeContext?.featureSummary || null,
      },
      technicalError: pageDoc.technicalError,
    })),
  };

  writeFileSync(path.join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

function buildEmptyExtract(url, technicalError) {
  return {
    title: titleFromUrl(url),
    url,
    headings: [],
    forms: [],
    fields: [],
    buttons: [],
    landmarks: [],
    tables: [],
    actionLinks: [],
    textPreview: technicalError || "",
  };
}

function resolveProviderFiles(globs) {
  const files = new Set();

  for (const glob of globs) {
    for (const file of expandGlob(glob)) {
      if (existsSync(file)) {
        files.add(file);
      }
    }
  }

  return [...files].sort(providerFileSort);
}

function providerFileSort(a, b) {
  const aVendor = a.includes("/vendor/");
  const bVendor = b.includes("/vendor/");

  if (aVendor !== bVendor) {
    return aVendor ? -1 : 1;
  }

  return a.localeCompare(b);
}

function expandGlob(pattern) {
  if (!pattern.includes("*")) {
    return [resolveProjectPath(pattern)];
  }

  const parts = pattern.split("/");
  const results = [];

  walkGlob(repoRoot, parts, 0, results);

  return results;
}

function walkGlob(currentDir, parts, index, results) {
  if (index >= parts.length) {
    results.push(currentDir);
    return;
  }

  const part = parts[index];

  if (part === "*") {
    if (!existsSync(currentDir)) {
      return;
    }

    for (const entry of readdirSync(currentDir)) {
      const next = path.join(currentDir, entry);

      if (statSync(next).isDirectory()) {
        walkGlob(next, parts, index + 1, results);
      }
    }

    return;
  }

  if (part.includes("*")) {
    const regex = new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`);

    if (!existsSync(currentDir)) {
      return;
    }

    for (const entry of readdirSync(currentDir)) {
      if (!regex.test(entry)) {
        continue;
      }

      walkGlob(path.join(currentDir, entry), parts, index + 1, results);
    }

    return;
  }

  walkGlob(path.join(currentDir, part), parts, index + 1, results);
}

function parseControllerAliases(content, namespaceName, uses) {
  const body = functionBody(content, "getControllers");

  if (!body) {
    return [];
  }

  return parsePhpArrayAliases(body, namespaceName, uses);
}

function parseModelAliases(content, namespaceName, uses) {
  const body = propertyArrayBody(content, "models");

  if (!body) {
    return [];
  }

  return parsePhpArrayAliases(body, namespaceName, uses);
}

function parseRoutePatterns(content, providerFile) {
  const patterns = [];
  const routeRegex = /->addStandardRoute\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*\[([\s\S]*?)\]\s*(?:,|\))/g;
  let match;

  while ((match = routeRegex.exec(content))) {
    const defaults = match[3];
    const controller = phpArrayStringValue(defaults, "controller");

    if (!controller) {
      continue;
    }

    const pattern = normaliseRoutePattern(match[2]);

    patterns.push({
      name: match[1],
      pattern,
      segments: routePatternSegments(pattern),
      controller,
      action: phpArrayStringValue(defaults, "action") || "index",
      providerFile,
    });
  }

  return patterns;
}

function phpArrayStringValue(body, key) {
  const match = new RegExp(`['"]${key}['"]\\s*=>\\s*['"]([^'"]+)['"]`).exec(body);

  return match?.[1] || "";
}

function normaliseRoutePattern(value) {
  return String(value || "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function routePatternSegments(pattern) {
  const segments = normaliseRoutePattern(pattern).split("/").filter(Boolean);

  return segments[0] === "cp" ? segments.slice(1) : segments;
}

function routePatternSort(a, b) {
  const literalDifference = routeLiteralSegmentCount(b) - routeLiteralSegmentCount(a);

  if (literalDifference) {
    return literalDifference;
  }

  return b.segments.length - a.segments.length;
}

function routeLiteralSegmentCount(pattern) {
  return pattern.segments.filter((segment) => !segment.startsWith(":")).length;
}

function parsePhpArrayAliases(body, namespaceName, uses) {
  const aliases = [];
  const pairRegex = /['"]([^'"]+)['"]\s*=>\s*(?:['"]([^'"]+)['"]|([A-Za-z_][A-Za-z0-9_\\]*)::class)/g;
  let match;

  while ((match = pairRegex.exec(body))) {
    aliases.push([
      match[1],
      resolvePhpClass(match[2] || match[3], namespaceName, uses),
    ]);
  }

  return aliases;
}

function functionBody(content, functionName) {
  const functionMatch = new RegExp(`function\\s+${functionName}\\s*\\([^)]*\\)[^{]*\\{`, "m").exec(content);

  if (!functionMatch) {
    return "";
  }

  const start = functionMatch.index + functionMatch[0].length;
  const end = matchingBraceEnd(content, start - 1);

  return end > start ? content.slice(start, end) : "";
}

function propertyArrayBody(content, propertyName) {
  const propertyMatch = new RegExp(`\\$${propertyName}\\s*=\\s*\\[`, "m").exec(content);

  if (!propertyMatch) {
    return "";
  }

  const start = propertyMatch.index + propertyMatch[0].length;
  const end = matchingBracketEnd(content, start - 1, "[", "]");

  return end > start ? content.slice(start, end) : "";
}

function matchingBraceEnd(content, openIndex) {
  return matchingBracketEnd(content, openIndex, "{", "}");
}

function matchingBracketEnd(content, openIndex, openChar, closeChar) {
  let depth = 0;

  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index];

    if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function extractNamespace(content) {
  return content.match(/namespace\s+([^;]+);/)?.[1]?.trim() || "";
}

function extractUseMap(content) {
  const uses = new Map();
  const useRegex = /^use\s+([^;]+);/gm;
  let match;

  while ((match = useRegex.exec(content))) {
    const full = match[1].trim();
    const aliasMatch = full.match(/\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
    const className = aliasMatch ? full.replace(/\s+as\s+[A-Za-z_][A-Za-z0-9_]*$/i, "").trim() : full;
    const shortName = aliasMatch ? aliasMatch[1] : className.split("\\").pop();

    uses.set(shortName, className);
  }

  return uses;
}

function extractClassDocSummary(content) {
  const match = content.match(/\/\*\*([\s\S]*?)\*\/\s*(?:abstract\s+|final\s+)?class\s+[A-Za-z_][A-Za-z0-9_]*/);

  return match ? cleanDocblock(match[1]) : "";
}

function extractMethodSummaries(content) {
  const summaries = [];
  const methodRegex = /\/\*\*([\s\S]*?)\*\/\s*(?:public|protected)\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match;

  while ((match = methodRegex.exec(content))) {
    const summary = cleanDocblock(match[1]);

    if (summary) {
      summaries.push({
        name: match[2],
        summary,
      });
    }
  }

  return summaries;
}

function extractActionTexts(content) {
  const texts = [];
  const regex = /->(?:setTitle|setConfirm)\(\s*['"]([^'"]+)['"]\s*\)|D3R::systemMessage\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;

  while ((match = regex.exec(content))) {
    texts.push(match[1] || match[2]);
  }

  return [...new Set(texts.map(markdownText).filter(Boolean))];
}

function cleanDocblock(block) {
  return String(block || "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter((line) => line && !line.startsWith("@") && !/^-\s*$/i.test(line))
    .filter((line) => !/^@?author\b/i.test(line))
    .join(" ")
    .replace(/\s+-\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function referencedClassReferences(content) {
  const refs = [];
  const seen = new Set();
  const stringRegex = /['"]((?:App|Soho|D3R)\\[^'"]+)['"]/g;
  let match;

  while ((match = stringRegex.exec(content))) {
    const className = match[1].replace(/\\\\/g, "\\");
    const file = classToFile(className);

    if (file && !seen.has(file)) {
      seen.add(file);
      refs.push(reference("referenced-class", file));
    }
  }

  return refs;
}

function resolvePhpClass(className, namespaceName, uses) {
  if (!className) {
    return "";
  }

  if (className.startsWith("\\")) {
    return className.slice(1);
  }

  if (className.includes("\\")) {
    return className;
  }

  if (uses.has(className)) {
    return uses.get(className);
  }

  return namespaceName ? `${namespaceName}\\${className}` : className;
}

function classToFile(className) {
  if (!className) {
    return "";
  }

  const mappings = [
    ["App\\", path.join(repoRoot, "src")],
    ["Soho\\Ecom\\", path.join(repoRoot, "vendor/soho/ecom/src")],
    ["Soho\\Products\\Base\\", path.join(repoRoot, "vendor/soho/products/src")],
    ["D3R\\Ecom\\", path.join(repoRoot, "vendor/d3r/ecom/src")],
  ];

  for (const [prefix, baseDir] of mappings) {
    if (!className.startsWith(prefix)) {
      continue;
    }

    const relative = `${className.slice(prefix.length).replace(/\\/g, "/")}.php`;
    const file = path.join(baseDir, relative);

    if (existsSync(file)) {
      return file;
    }
  }

  for (const mapping of getComposerPsr4Mappings()) {
    if (!className.startsWith(mapping.prefix)) {
      continue;
    }

    const relative = `${className.slice(mapping.prefix.length).replace(/\\/g, "/")}.php`;

    for (const baseDir of mapping.dirs) {
      const file = path.join(baseDir, relative);

      if (existsSync(file)) {
        return file;
      }
    }
  }

  return "";
}

function getComposerPsr4Mappings() {
  if (composerPsr4Mappings) {
    return composerPsr4Mappings;
  }

  const autoloadFile = path.join(repoRoot, "vendor/composer/autoload_psr4.php");

  if (!existsSync(autoloadFile)) {
    composerPsr4Mappings = [];
    return composerPsr4Mappings;
  }

  const vendorDir = path.join(repoRoot, "vendor");
  const baseDir = repoRoot;
  const content = readFileSync(autoloadFile, "utf8");
  const mappings = [];
  const entryRegex = /'([^']+)' => array\(([^)]*)\)/g;
  let match;

  while ((match = entryRegex.exec(content))) {
    const prefix = match[1].replace(/\\\\/g, "\\");
    const dirs = [];
    const pathRegex = /\$(vendorDir|baseDir)\s*\.\s*'([^']+)'/g;
    let pathMatch;

    while ((pathMatch = pathRegex.exec(match[2]))) {
      dirs.push(path.join(pathMatch[1] === "vendorDir" ? vendorDir : baseDir, pathMatch[2]));
    }

    if (dirs.length) {
      mappings.push({ prefix, dirs });
    }
  }

  composerPsr4Mappings = mappings.sort((a, b) => b.prefix.length - a.prefix.length);

  return composerPsr4Mappings;
}

function extractControllerProperty(content, propertyName) {
  const match = new RegExp(`\\$${propertyName}\\s*=\\s*['"]([^'"]+)['"]`).exec(content);

  return match?.[1] || "";
}

function extractExtendsClass(content) {
  return content.match(/class\s+[A-Za-z_][A-Za-z0-9_]*\s+extends\s+([A-Za-z_\\][A-Za-z0-9_\\]*)/)?.[1] || "";
}

function extractMethodNames(content) {
  const methods = [];
  const methodRegex = /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match;

  while ((match = methodRegex.exec(content))) {
    methods.push(match[1]);
  }

  return methods;
}

function findViewReferences(controllerFile, content, render, action) {
  const refs = [];
  const controllerDir = path.dirname(controllerFile);
  const candidates = [
    render,
    action,
    "index",
    ...extractRenderNames(content),
  ].filter(Boolean);

  for (const name of [...new Set(candidates)]) {
    for (const file of [
      path.join(controllerDir, "views", `${name}.twig`),
      path.join(controllerDir, "views", `${name}.html`),
      path.join(controllerDir, "views", `${name}.php`),
      path.join(controllerDir, `${name}.twig`),
    ]) {
      if (existsSync(file)) {
        refs.push(reference("view", file));
      }
    }
  }

  return refs;
}

function extractRenderNames(content) {
  const names = [];
  const renderRegex = /\$_render\s*=\s*['"]([^'"]+)['"]/g;
  let match;

  while ((match = renderRegex.exec(content))) {
    names.push(match[1]);
  }

  return names;
}

function findModelXmlFile(modelFile) {
  if (!modelFile) {
    return "";
  }

  const xmlFile = modelFile.replace(/\.php$/, ".xml");

  return existsSync(xmlFile) ? xmlFile : "";
}

function parseModelXmlFields(xmlFile) {
  const xml = readFileSync(xmlFile, "utf8");
  const fields = [];
  const fieldRegex = /<field\b[^>]*>([\s\S]*?)<\/field>/gi;
  let match;

  while ((match = fieldRegex.exec(xml))) {
    const block = match[1];
    fields.push({
      name: xmlTag(block, "name"),
      dbname: xmlTag(block, "dbname"),
      type: xmlTag(block, "type"),
      required: xmlTag(block, "required") || xmlTag(block, "mandatory"),
      description: xmlTag(block, "description") || xmlTag(block, "help") || xmlTag(block, "info") || xmlTag(block, "note"),
    });
  }

  return fields;
}

function xmlTag(block, tagName) {
  const match = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i").exec(block);

  return match ? decodeXml(match[1].replace(/<[^>]+>/g, "").trim()) : "";
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'");
}

function normaliseFieldName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\[\]$/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function reference(type, file) {
  return file ? { type, file } : null;
}

function uniqueReferences(references) {
  const seen = new Set();
  const unique = [];

  for (const item of references.filter(Boolean)) {
    const key = `${item.type}:${item.file}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(item);
  }

  return unique;
}

function readLimited(file) {
  if (!file || !existsSync(file)) {
    return "";
  }

  const maxFileBytes = Number(config.codeAnalysis?.maxFileBytes || 60000);
  const content = readFileSync(file, "utf8");

  return content.length > maxFileBytes ? content.slice(0, maxFileBytes) : content;
}

function loadConfig(parsedArgs) {
  const configPath = parsedArgs.config
    ? resolveProjectPath(parsedArgs.config)
    : defaultConfigPath();

  if (!existsSync(configPath)) {
    fail(`Config file not found: ${configPath}`);
  }

  const loaded = JSON.parse(readFileSync(configPath, "utf8"));
  const merged = {
    siteName: "Site",
    startUrls: ["/"],
    outputDir: "docs",
    ignoreHTTPSErrors: false,
    waitUntil: "networkidle",
    readySelector: "body",
    postNavigateWaitMs: 500,
    timeoutMs: 45000,
    auth: "anonymous",
    crawl: {
      enabled: true,
      maxPages: 1,
      linkSelector: "a",
      includePatterns: ["^/"],
      excludePatterns: [],
    },
    viewports: [
      {
        name: "desktop",
        width: 1440,
        height: 1100,
        fullPage: true,
      },
    ],
    codeAnalysis: {
      enabled: true,
      maxFileBytes: 60000,
      providerGlobs: [
        "src/Provider.php",
        "src/*/Provider.php",
        "vendor/d3r/*/src/Provider.php",
        "vendor/d3r/*/src/*/Provider.php",
        "vendor/soho/*/src/Provider.php",
        "vendor/soho/*/src/*/Provider.php",
        "vendor/soho/ecom/src/Provider.php",
        "vendor/soho/products/src/Provider.php",
        "vendor/soho/ecom/src/*/Provider.php",
        "vendor/soho/products/src/*/Provider.php",
      ],
    },
    ...loaded,
  };

  merged.crawl = {
    enabled: true,
    maxPages: 1,
    linkSelector: "a",
    includePatterns: ["^/"],
    excludePatterns: [],
    ...(loaded.crawl || {}),
  };
  merged.codeAnalysis = {
    enabled: true,
    maxFileBytes: 60000,
    providerGlobs: [
      "src/Provider.php",
      "src/*/Provider.php",
      "vendor/d3r/*/src/Provider.php",
      "vendor/d3r/*/src/*/Provider.php",
      "vendor/soho/*/src/Provider.php",
      "vendor/soho/*/src/*/Provider.php",
      "vendor/soho/ecom/src/Provider.php",
      "vendor/soho/products/src/Provider.php",
      "vendor/soho/ecom/src/*/Provider.php",
      "vendor/soho/products/src/*/Provider.php",
    ],
    ...(loaded.codeAnalysis || {}),
  };

  if (parsedArgs.siteName) {
    merged.siteName = parsedArgs.siteName;
  }

  if (!Array.isArray(merged.viewports) || !merged.viewports.length) {
    fail("Config must define at least one viewport.");
  }

  return merged;
}

function defaultConfigPath() {
  const configPath = path.join(scriptDir, "config.json");

  if (existsSync(configPath)) {
    return configPath;
  }

  return path.join(scriptDir, "config.example.json");
}

function loadStartUrls(loadedConfig, parsedArgs) {
  const configuredUrls = parsedArgs.urls.length
    ? parsedArgs.urls
    : [...(loadedConfig.startUrls || []), ...loadRouteSourceUrls(loadedConfig)];
  const startUrls = [...new Set(configuredUrls)];

  if (!Array.isArray(startUrls) || !startUrls.length) {
    fail("No startUrls configured.");
  }

  return startUrls.map(resolveUrl);
}

function loadRouteSourceUrls(loadedConfig) {
  const routeSource = loadedConfig.routeSource;

  if (!routeSource || routeSource.enabled === false) {
    return [];
  }

  if (routeSource.type !== "cp-site-tree") {
    fail(`Unsupported routeSource type: ${routeSource.type}`);
  }

  const scriptPath = resolveProjectPath(routeSource.path || "actions/cp-site-tree-routes.php");

  if (!existsSync(scriptPath)) {
    fail(`routeSource script not found: ${scriptPath}`);
  }

  const args = [scriptPath];

  if (routeSource.includeHidden === false || routeSource.visibleOnly) {
    args.push("--visible-only");
  }

  if (routeSource.absolute) {
    args.push("--absolute");
  }

  if (routeSource.baseUrl) {
    args.push("--base-url", routeSource.baseUrl);
  }

  const result = spawnSync("php", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.status !== 0 && result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    fail(`routeSource script failed with exit code ${result.status}`);
  }

  const parsed = parseJsonFromText(result.stdout);

  if (!Array.isArray(parsed.routes)) {
    fail("routeSource script did not return a routes array.");
  }

  console.log(`Loaded ${parsed.routes.length} routes from ${routeSource.type}`);

  return parsed.routes
    .map((route) => {
      if (!route.url) {
        return "";
      }

      const url = resolveUrl(route.url);
      registerRouteMetadata(url, route);

      return route.url;
    })
    .filter(Boolean);
}

function resolveUrl(url) {
  if (/^https?:\/\//i.test(url) || /^file:\/\//i.test(url)) {
    return url;
  }

  const localPath = url.startsWith("/") ? "" : resolveProjectPath(url);

  if (localPath && existsSync(localPath)) {
    return pathToFileURL(localPath).href;
  }

  if (!config.baseUrl) {
    fail(`Relative URL "${url}" requires baseUrl in config.`);
  }

  return new URL(url, config.baseUrl).href;
}

function isAllowedUrl(url, loadedConfig) {
  if (/^file:\/\//i.test(url)) {
    return true;
  }

  const base = new URL(loadedConfig.baseUrl);
  const candidate = new URL(url);

  if (candidate.origin !== base.origin) {
    return false;
  }

  const pathAndQuery = `${candidate.pathname}${candidate.search}`;
  const crawlConfig = loadedConfig.crawl || {};
  const includePatterns = patterns(crawlConfig.includePatterns || []);
  const excludePatterns = patterns(crawlConfig.excludePatterns || []);
  const included = !includePatterns.length || includePatterns.some((pattern) => pattern.test(pathAndQuery));
  const excluded = excludePatterns.some((pattern) => pattern.test(pathAndQuery));

  return included && !excluded;
}

function normaliseVisitKey(url) {
  if (/^file:\/\//i.test(url)) {
    return url.replace(/#.*$/, "");
  }

  const parsed = new URL(url);
  parsed.hash = "";

  return parsed.href;
}

function registerRouteMetadata(url, metadata) {
  if (/^file:\/\//i.test(url)) {
    return;
  }

  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  routeMetadataByUrl.set(parsed.href, {
    title: metadata.title || "",
    path: metadata.path || [],
    source: metadata.source || "",
  });
}

function routeMetadataForUrl(url) {
  if (/^file:\/\//i.test(url)) {
    return null;
  }

  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";

  if (routeMetadataByUrl.has(parsed.href)) {
    return routeMetadataByUrl.get(parsed.href);
  }

  const segments = parsed.pathname.split("/").filter(Boolean);

  while (segments.length > 1) {
    segments.pop();
    const candidate = new URL(parsed.href);
    candidate.pathname = `/${segments.join("/")}`;

    if (routeMetadataByUrl.has(candidate.href)) {
      return routeMetadataByUrl.get(candidate.href);
    }
  }

  return null;
}

function documentationVisitKey(url) {
  if (config.crawl?.dedupeDynamicRoutes === false || /^file:\/\//i.test(url)) {
    return normaliseVisitKey(url);
  }

  const index = config.codeAnalysis?.enabled === false ? null : getCodeIndex();
  const route = routePartsForUrl(url, index);
  const parsed = new URL(url);

  if (!route.controllerAlias) {
    parsed.hash = "";
    parsed.search = "";

    return parsed.href;
  }

  return [
    parsed.origin,
    route.cp ? "cp" : "site",
    route.controllerAlias,
    normaliseActionName(route.action),
    documentationRoutePattern(route),
  ].join("|");
}

function documentationRoutePattern(route) {
  if (route.routePattern?.pattern) {
    return route.routePattern.pattern;
  }

  if (!route.routeSegments?.length) {
    return route.path;
  }

  const segments = [route.controllerAlias || route.routeSegments[0]];
  const action = normaliseActionName(route.action);

  if (action && action !== "index") {
    segments.push(action);
  }

  const consumed = segments.length;

  if (route.routeSegments.length > consumed) {
    segments.push(":identifier");
  }

  return segments.join("/");
}

function normaliseActionName(action) {
  return String(action || "index").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function discoverControllerActionUrls(pageDoc) {
  if (config.crawl?.discoverControllerActions === false || !pageDoc.codeContext?.route?.controllerAlias) {
    return [];
  }

  const urls = [];
  const seen = new Set();
  const index = getCodeIndex();
  const currentRoute = pageDoc.codeContext.route;

  const add = (url) => {
    const resolvedUrl = resolveUrl(url);

    if (!isAllowedUrl(resolvedUrl, config) || !isSafeDocumentationActionUrl(resolvedUrl)) {
      return;
    }

    if (isCrudDocumentationUrl(resolvedUrl) && !canDocumentCrudForConfiguredAuth()) {
      return;
    }

    const key = documentationVisitKey(resolvedUrl);

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    urls.push(resolvedUrl);
  };

  if (canDiscoverControllerRoutePatterns(pageDoc)) {
    for (const routePattern of index.routePatterns || []) {
      if (routePattern.controller !== currentRoute.controllerAlias || routePattern.segments.some((segment) => segment.startsWith(":"))) {
        continue;
      }

      if (!isSafeDocumentationActionName(routePattern.action)) {
        continue;
      }

      add(routePatternToUrl(routePattern, currentRoute.cp));
    }
  }

  for (const link of pageDoc.extracted.actionLinks || []) {
    if (!link.href || !isSafeDocumentationActionUrl(link.href)) {
      continue;
    }

    const linkRoute = routePartsForUrl(link.href, index);

    if (!isRelatedDocumentationRoute(currentRoute, linkRoute)) {
      continue;
    }

    add(link.href);
  }

  return urls;
}

function shouldFollowDiscoveredLink(pageDoc, url) {
  if (!isSafeDocumentationActionUrl(url)) {
    return false;
  }

  if (isCrudDocumentationUrl(url) && !canDocumentCrudForConfiguredAuth()) {
    return false;
  }

  const currentRoute = pageDoc.codeContext?.route;

  if (!currentRoute) {
    return true;
  }

  const linkRoute = routePartsForUrl(url, getCodeIndex());

  if (!isRelatedDocumentationRoute(currentRoute, linkRoute)) {
    return false;
  }

  if (!currentRoute.routePattern || currentRoute.routePattern.segments.some((segment) => segment.startsWith(":"))) {
    return true;
  }

  if (linkRoute.routePattern) {
    return true;
  }

  return !(linkRoute.action === currentRoute.action && linkRoute.routeSegments.length > currentRoute.routeSegments.length);
}

function isRelatedCrudDocumentationUrl(pageDoc, url) {
  const currentRoute = pageDoc.codeContext?.route;

  if (!currentRoute || !isCrudDocumentationUrl(url)) {
    return false;
  }

  if (!canDocumentCrudForConfiguredAuth()) {
    return false;
  }

  const linkRoute = routePartsForUrl(url, getCodeIndex());

  return isRelatedDocumentationRoute(currentRoute, linkRoute);
}

function canDiscoverControllerRoutePatterns(pageDoc) {
  if (!isClientVisibleCpDocsRun() || !pageDoc.codeContext?.route?.cp) {
    return true;
  }

  return false;
}

function canDocumentCrudForConfiguredAuth() {
  if (!isClientVisibleCpDocsRun()) {
    return true;
  }

  const auth = normaliseAuth(config.auth);
  const email = resolveOptionalAuthValue(auth?.email, auth?.emailEnv);

  return !email || !looksLikeD3REmail(email);
}

function isCrudDocumentationUrl(url) {
  const parsed = new URL(url, config.baseUrl);

  return /\/edit\/new\/?$/i.test(parsed.pathname)
    || /\/(?:new|add|create)\/?$/i.test(parsed.pathname)
    || /\/(?:edit|show|view)(?:\/[^/]+)?\/?$/i.test(parsed.pathname);
}

function routePatternToUrl(routePattern, cp) {
  const pathPrefix = cp ? "/cp/" : "/";

  return new URL(`${pathPrefix}${routePattern.pattern}`, config.baseUrl).href;
}

function isRelatedDocumentationRoute(currentRoute, linkRoute) {
  if (!linkRoute.controllerAlias) {
    return false;
  }

  if (linkRoute.controllerAlias === currentRoute.controllerAlias) {
    return true;
  }

  return Boolean(linkRoute.routePattern?.pattern?.startsWith(`${currentRoute.controllerAlias}/`));
}

function isSafeDocumentationActionUrl(url) {
  const parsed = new URL(url, config.baseUrl);
  const pathAndQuery = `${parsed.pathname}${parsed.search}`.toLowerCase();

  return isSafeDocumentationActionName(pathAndQuery);
}

function isSafeDocumentationActionName(value) {
  const unsafe = config.crawl?.unsafeActionPattern
    ? new RegExp(config.crawl.unsafeActionPattern, "i")
    : /(?:\/action(?:\/|$)|[?&](?:action|method)=|\/(?:new|add|create)\/[^/?#]+|\/(?:delete|remove|logout|impersonate|export|download|print|back-in-stock|send|sync|import|process|queue|retry|accept|approve|reject|decline|cancel|capture|refund|resend|flush|clear|expire|undelete|restore|duplicate|copy|options|page-info|ajax|json)(?:\/|$|\?)|token=)/i;

  return !unsafe.test(String(value || ""));
}

function pageSlugForUrl(url, pageNumber) {
  const fileUrl = /^file:\/\//i.test(url);
  const parsed = fileUrl ? null : new URL(url);
  const source = fileUrl ? path.basename(new URL(url).pathname) : `${parsed.pathname}-${parsed.search}`;
  const readable = slug(source.replace(/[?=&]+/g, "-")) || "page";
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 8);

  return `${String(pageNumber).padStart(3, "0")}-${readable}-${hash}`;
}

function parseArgs(argv) {
  const parsed = {
    urls: [],
    help: false,
    noCrawl: false,
    clean: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--config") {
      parsed.config = requireValue(argv, index += 1, arg);
    } else if (arg === "--url") {
      parsed.urls.push(requireValue(argv, index += 1, arg));
    } else if (arg === "--output") {
      parsed.output = requireValue(argv, index += 1, arg);
    } else if (arg === "--max-pages") {
      parsed.maxPages = Number(requireValue(argv, index += 1, arg));
    } else if (arg === "--site-name") {
      parsed.siteName = requireValue(argv, index += 1, arg);
    } else if (arg === "--no-crawl") {
      parsed.noCrawl = true;
    } else if (arg === "--clean") {
      parsed.clean = true;
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

function buildAuthCookie(loadedConfig, url) {
  const auth = normaliseAuth(loadedConfig.auth);

  if (!auth || auth.type === "anonymous") {
    return null;
  }

  const targetUrl = new URL(url);
  const payload = {
    type: auth.type,
    exp: Math.floor(Date.now() / 1000) + Number(auth.ttlSeconds || loadedConfig.authTtlSeconds || 3600),
  };

  if (auth.email || auth.emailEnv) {
    payload.email = resolveAuthValue(auth.email, auth.emailEnv, `${auth.type} email`);
  }

  if (auth.id || auth.idEnv) {
    payload.id = resolveAuthValue(auth.id, auth.idEnv, `${auth.type} id`);
  }

  if (!payload.email && !payload.id) {
    fail(`Auth type ${payload.type} requires email/emailEnv or id/idEnv.`);
  }

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", "soho-home-vision-loop-local-auth")
    .update(encodedPayload)
    .digest("hex");

  return {
    name: "vision_loop_auth",
    value: `${encodedPayload}.${signature}`,
    domain: targetUrl.hostname,
    path: "/",
    httpOnly: true,
    secure: targetUrl.protocol === "https:",
    sameSite: "Lax",
    expires: payload.exp,
  };
}

function requiresAuthMiddleware(loadedConfig) {
  const auth = normaliseAuth(loadedConfig.auth);

  return Boolean(auth && auth.type !== "anonymous");
}

function validateAuthRequirements(loadedConfig) {
  const auth = normaliseAuth(loadedConfig.auth);

  if (!auth || auth.type === "anonymous") {
    return;
  }

  const email = resolveOptionalAuthValue(auth.email, auth.emailEnv);
  const id = resolveOptionalAuthValue(auth.id, auth.idEnv);

  if (isClientVisibleCpDocsRun(loadedConfig)) {
    if (!email) {
      fail(`Client-visible CP docs require an admin email identity. Set ${auth.emailEnv || "FEATURE_DOCS_ADMIN_EMAIL"} to a non-D3R superuser/admin email.`);
    }

    if (looksLikeD3REmail(email)) {
      fail(`Client-visible CP docs cannot run with D3R admin email ${email}. Use a non-D3R superuser/admin email so the crawler only sees client-facing CP pages.`);
    }
  }

  if (email || id) {
    return;
  }

  fail(`Missing ${auth.type} identity. Set ${auth.emailEnv || auth.idEnv || "an auth env var"} or provide a literal value in the feature-docs config.`);
}

function isClientVisibleCpDocsRun(loadedConfig = config) {
  const crawlConfig = loadedConfig.crawl || {};

  if (crawlConfig.clientVisibleCrudOnly === false) {
    return false;
  }

  const routeSource = loadedConfig.routeSource || {};

  if (routeSource.type === "cp-site-tree") {
    return true;
  }

  if ((loadedConfig.startUrls || []).some((url) => /^\/cp(?:\/|$)/i.test(String(url)))) {
    return true;
  }

  return (crawlConfig.includePatterns || []).some((pattern) => String(pattern).includes("/cp") || String(pattern).includes("\\/cp"));
}

function normaliseAuth(auth) {
  if (!auth) {
    return null;
  }

  if (typeof auth === "string") {
    return { type: auth };
  }

  if (auth.adminEmail || auth.adminEmailEnv || auth.adminId || auth.adminIdEnv) {
    return {
      type: "admin",
      email: auth.adminEmail,
      emailEnv: auth.adminEmailEnv,
      id: auth.adminId,
      idEnv: auth.adminIdEnv,
      ttlSeconds: auth.ttlSeconds,
    };
  }

  if (auth.customerEmail || auth.customerEmailEnv || auth.customerId || auth.customerIdEnv) {
    return {
      type: "customer",
      email: auth.customerEmail,
      emailEnv: auth.customerEmailEnv,
      id: auth.customerId,
      idEnv: auth.customerIdEnv,
      ttlSeconds: auth.ttlSeconds,
    };
  }

  return auth;
}

function resolveAuthValue(value, envName, label) {
  if (value) {
    return value;
  }

  if (envName && process.env[envName]) {
    return process.env[envName];
  }

  if (envName) {
    const fallback = getAuthEnvDefault(envName);

    if (fallback) {
      return fallback;
    }
  }

  if (envName) {
    fail(`Missing ${label}. Set ${envName} or provide a literal value in the feature-docs config.`);
  }

  return null;
}

function resolveOptionalAuthValue(value, envName) {
  if (value) {
    return value;
  }

  if (envName && process.env[envName]) {
    return process.env[envName];
  }

  if (envName) {
    return getAuthEnvDefault(envName);
  }

  return null;
}

function getAuthEnvDefault(envName) {
  if (envName === "FEATURE_DOCS_ADMIN_EMAIL") {
    return "rebecca.hone@sohohouse.com";
  }

  return null;
}

function looksLikeD3REmail(value) {
  return /@d3r\.com$/i.test(String(value || "").trim());
}

function ensureAuthMiddlewareEnabled() {
  if (authMiddlewareEnabled) {
    return;
  }

  toggleAuthMiddleware("enable");
  authMiddlewareEnabled = true;
}

function ensureAuthMiddlewareDisabled() {
  if (!authMiddlewareEnabled) {
    return;
  }

  toggleAuthMiddleware("disable");
  authMiddlewareEnabled = false;
}

function toggleAuthMiddleware(action) {
  const togglePath = path.resolve(repoRoot, ".vscode/vision-loop/vision-loop-auth-toggle.mjs");

  if (!existsSync(togglePath)) {
    fail(`Vision Loop auth toggle not found: ${togglePath}`);
  }

  const result = spawnSync(process.execPath, [togglePath, action], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    throw new Error(`Failed to ${action} feature-docs auth middleware hook`);
  }
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function importPackage(packageName) {
  const candidates = [
    path.join(scriptDir, "node_modules", packageName, "package.json"),
    path.join(scriptDir, "..", "vision-loop", "node_modules", packageName, "package.json"),
  ];

  for (const packageJsonPath of candidates) {
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const packageDir = path.dirname(packageJsonPath);
    const entry = packageEntry(packageJson);

    return import(pathToFileURL(path.join(packageDir, entry)).href);
  }

  try {
    return await import(packageName);
  } catch (error) {
    fail(`Unable to import "${packageName}". Run npm install in .vscode/feature-docs. ${error.message}`);
  }
}

function packageEntry(packageJson) {
  const rootExport = packageJson.exports?.["."];

  if (typeof rootExport === "string") {
    return rootExport;
  }

  if (rootExport?.import) {
    return rootExport.import;
  }

  if (rootExport?.default) {
    return rootExport.default;
  }

  return packageJson.module || packageJson.main || "index.js";
}

function parseJsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const match = text.match(/\{[\s\S]*\}/);

    if (!match) {
      throw error;
    }

    return JSON.parse(match[0]);
  }
}

function ensureArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }

  if (!value) {
    return [];
  }

  return [String(value)];
}

function patterns(values) {
  return values.map((value) => new RegExp(value, "i"));
}

function resolveProjectPath(value) {
  if (path.isAbsolute(value)) {
    return value;
  }

  const cwdPath = path.resolve(process.cwd(), value);

  if (existsSync(cwdPath)) {
    return cwdPath;
  }

  const scriptPath = path.resolve(scriptDir, value);

  if (existsSync(scriptPath)) {
    return scriptPath;
  }

  return path.resolve(repoRoot, value);
}

function resolveFromScriptDir(value) {
  if (path.isAbsolute(value)) {
    return value;
  }

  return path.resolve(scriptDir, value);
}

function relativeTo(from, to) {
  return path.relative(from, to).split(path.sep).join("/");
}

function titleFromUrl(url) {
  if (/^file:\/\//i.test(url)) {
    return path.basename(new URL(url).pathname);
  }

  const parsed = new URL(url);
  const finalPart = parsed.pathname.split("/").filter(Boolean).pop();

  return finalPart ? finalPart.replace(/[-_]+/g, " ") : parsed.hostname;
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function markdownText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isNoisyCpTitle(value) {
  const title = markdownText(value).toLowerCase();

  return title === "favourites";
}

function markdownAlt(value) {
  return markdownText(value).replace(/[\[\]()]/g, "");
}

function markdownCode(value) {
  return String(value || "").replace(/`/g, "");
}

function markdownUrl(value) {
  const url = String(value || "").trim();

  return url ? `[${markdownText(url)}](${url.replace(/\)/g, "%29")})` : "";
}

function markdownTableText(value) {
  return markdownText(value).replace(/\|/g, "\\|");
}

function publicPageUrl(url) {
  const publicBaseUrl = config.publicBaseUrl || config.humanDocs?.publicBaseUrl;

  if (!publicBaseUrl) {
    return url;
  }

  try {
    const source = new URL(url);
    const target = new URL(publicBaseUrl);
    target.pathname = source.pathname;
    target.search = source.search;
    target.hash = source.hash;

    return target.toString();
  } catch {
    return url;
  }
}

function formatTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnShell(command, options) {
  const child = spawn(command, {
    cwd: options.cwd,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => process.stdout.write(`[${options.prefix}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${options.prefix}] ${chunk}`));

  return child;
}

function printHelp() {
  console.log(`
Usage: node feature-docs.mjs [options]

Options:
  --config <path>       Config path. Defaults to config.json, then config.example.json.
  --url <url>           Start URL. Can be passed more than once.
  --output <name>       Output run folder name under config.outputDir.
  --max-pages <count>   Maximum pages to document.
  --site-name <name>    Override config.siteName.
  --no-crawl            Only document configured start URLs.
  --clean               Remove the selected output folder before running.
  --help                Show this help.
`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
