import { Client } from '@notionhq/client';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

const COURSE_ID = process.env.CANVAS_STATS_COURSE_ID;
const BASE_URL = process.env.CANVAS_2_API_BASE;
const TOKEN = process.env.CANVAS_2_API_TOKEN;
const COURSE_LABEL = process.env.CANVAS_2_LABEL;
const RESOURCE_DB_ID = process.env.NOTION_COURSE_RESOURCE_DB_ID;
const COURSE_PLANNER_DB_ID = process.env.COURSE_PLANNER_DB;

// Fetch all paginated Canvas results
async function fetchAllPages(url) {
  let results = [];
  let nextUrl = url;

  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const data = await res.json();
    results = results.concat(data);
    const linkHeader = res.headers.get("link");
    const match = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : null;
  }

  return results;
}

async function fetchModules() {
  return fetchAllPages(`${BASE_URL}/api/v1/courses/${COURSE_ID}/modules`);
}

async function fetchModuleItems(moduleId) {
  return fetchAllPages(`${BASE_URL}/api/v1/courses/${COURSE_ID}/modules/${moduleId}/items`);
}

async function fetchContentText(item) {
  if (!item.url) return null;

  try {
    const res = await fetch(item.url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    return $("div.content, div.syllabus, div.lecture-content").text().trim().slice(0, 2000);
  } catch (err) {
    console.error(`❌ Error fetching content for ${item.title}: ${err.message}`);
    return null;
  }
}

async function findCoursePageId(name) {
  const res = await notion.databases.query({
    database_id: COURSE_PLANNER_DB_ID,
    filter: {
      property: "Canvas Course Name",
      rich_text: { equals: name },
    },
  });
  return res.results.length ? res.results[0].id : null;
}

// ==============================
// SYNC HANDLER
// ==============================
export default async function handler(req, res) {
  try {
    console.log("📘 Syncing Intro to Statistics course resource items...");

    const modules = await fetchModules();
    const coursePageId = await findCoursePageId("Intro to Statistics");
    if (!coursePageId) throw new Error("Course page not found in Notion");

    let count = 0;

    for (const module of modules) {
      const items = await fetchModuleItems(module.id);

      for (const item of items) {
        try {
          const notionQuery = await notion.databases.query({
            database_id: RESOURCE_DB_ID,
            filter: {
              property: "Canvas Module Item ID",
              rich_text: { equals: item.id.toString() },
            },
          });

          const contentText = await fetchContentText(item);

          const pageProps = {
            Name: { title: [{ text: { content: item.title || "Untitled" } }] },
            "Canvas Module Item ID": {
              rich_text: [{ text: { content: item.id.toString() } }],
            },
            Course: { relation: [{ id: coursePageId }] },
            Module: { rich_text: [{ text: { content: module.name || "(No Module)" } }] },
            Type: item.type ? { select: { name: item.type } } : undefined,
            Link: item.external_url
              ? { url: item.external_url }
              : item.html_url
              ? { url: item.html_url }
              : undefined,
            Summary: contentText
              ? { rich_text: [{ text: { content: contentText } }] }
              : undefined,
            "Last Synced": { date: { start: new Date().toISOString() } },
            "Auto-generated": { checkbox: true },
          };

          if (notionQuery.results.length > 0) {
            await notion.pages.update({
              page_id: notionQuery.results[0].id,
              properties: pageProps,
            });
            console.log(`♻️ Updated: ${item.title}`);
          } else {
            await notion.pages.create({
              parent: { database_id: RESOURCE_DB_ID },
              properties: pageProps,
            });
            console.log(`✨ Created: ${item.title}`);
          }

          count++;
        } catch (err) {
          console.error(`❌ Failed on "${item.title}": ${err.message}`);
        }
      }
    }

    res.status(200).send(`✅ Synced ${count} Intro to Stats items`);
  } catch (err) {
    console.error("❌ sync-resources-stats failed:", err.message);
    res.status(500).send("❌ sync-resources-stats failed");
  }
}
