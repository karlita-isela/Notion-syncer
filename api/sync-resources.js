import { Client } from '@notionhq/client';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

const canvasConfigs = [
  {
    token: process.env.CANVAS_1_API_TOKEN,
    baseUrl: process.env.CANVAS_1_API_BASE,
    label: process.env.CANVAS_1_LABEL,
  },
  {
    token: process.env.CANVAS_2_API_TOKEN,
    baseUrl: process.env.CANVAS_2_API_BASE,
    label: process.env.CANVAS_2_LABEL,
  },
].filter((c) => c.token && c.baseUrl);

async function fetchAllPages(url, token) {
  let results = [];
  let nextUrl = url;

  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    results = results.concat(data);
    const linkHeader = res.headers.get("link");
    const match = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : null;
  }
  return results;
}

async function fetchAndParseModuleItemContent(course, item, token) {
  if (!item.url) return null;
  try {
    const res = await fetch(item.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    const contentText = $("div.content, div.syllabus, div.lecture-content").text().trim();
    return contentText || null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    console.log("📚 Starting /api/sync-resources...");
    const MODULE_CONTENT_DB_ID = process.env.NOTION_COURSE_RESOURCE_DB_ID;
    const COURSE_PLANNER_DB = process.env.COURSE_PLANNER_DB;
    let resourceCount = 0;

    for (const config of canvasConfigs) {
      const courses = await fetchAllPages(`${config.baseUrl}/api/v1/courses`, config.token);
      for (const course of courses) {
        if (!course.name || !course.id || course.workflow_state !== "available") continue;

        console.log(`🔍 Syncing resources for: ${course.name}`);

        const modules = await fetchAllPages(`${config.baseUrl}/api/v1/courses/${course.id}/modules`, config.token);
        for (const module of modules) {
          const moduleItems = await fetchAllPages(`${config.baseUrl}/api/v1/courses/${course.id}/modules/${module.id}/items`, config.token);
          for (const item of moduleItems) {
            const content = await fetchAndParseModuleItemContent(course, item, config.token);

            const notionQuery = await notion.databases.query({
              database_id: MODULE_CONTENT_DB_ID,
              filter: {
                property: "Canvas Module Item ID",
                rich_text: { equals: item.id.toString() },
              },
            });

            const props = {
              Name: { title: [{ text: { content: item.title || "Untitled" } }] },
              "Canvas Module Item ID": {
                rich_text: [{ text: { content: item.id.toString() } }],
              },
              Course: { rich_text: [{ text: { content: course.name } }] },
              Module: { rich_text: [{ text: { content: module.name || "(No Module)" } }] },
              Link: item.external_url
                ? { url: item.external_url }
                : item.html_url
                ? { url: item.html_url }
                : undefined,
              Summary: content
                ? { rich_text: [{ text: { content: content.slice(0, 2000) } }] }
                : undefined,
              "Last Synced": { date: { start: new Date().toISOString() } },
              "Auto-generated": { checkbox: true },
            };

            if (notionQuery.results.length > 0) {
              await notion.pages.update({
                page_id: notionQuery.results[0].id,
                properties: props,
              });
              console.log(`♻️ Updated: ${item.title}`);
            } else {
              await notion.pages.create({
                parent: { database_id: MODULE_CONTENT_DB_ID },
                properties: props,
              });
              console.log(`✨ Created: ${item.title}`);
            }

            resourceCount++;
          }
        }
      }
    }

    res.status(200).send(`✅ Synced ${resourceCount} module resource items`);
  } catch (err) {
    console.error("❌ sync-resources failed:", err.message);
    res.status(500).send("❌ sync-resources failed");
  }
}
