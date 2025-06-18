// ==============================
// API Route: sync-resources-hcc.js (HCC Canvas)
// ==============================
import { Client } from '@notionhq/client';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
const MODULE_CONTENT_DB_ID = process.env.NOTION_COURSE_RESOURCE_DB_ID;
const COURSE_PLANNER_DB = process.env.COURSE_PLANNER_DB;

const canvasConfig = {
  token: process.env.CANVAS_1_API_TOKEN,
  baseUrl: process.env.CANVAS_1_API_BASE,
  label: process.env.CANVAS_1_LABEL,
};

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

async function fetchModules(course) {
  return fetchAllPages(
    `${canvasConfig.baseUrl}/api/v1/courses/${course.id}/modules`,
    canvasConfig.token
  );
}

async function fetchModuleItems(course, module) {
  return fetchAllPages(
    `${canvasConfig.baseUrl}/api/v1/courses/${course.id}/modules/${module.id}/items`,
    canvasConfig.token
  );
}

async function fetchAndParseContent(item) {
  if (!item.url) return null;
  try {
    const res = await fetch(item.url, {
      headers: { Authorization: `Bearer ${canvasConfig.token}` },
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    return $("div.content, div.syllabus, div.lecture-content").text().trim().slice(0, 2000);
  } catch {
    return null;
  }
}

async function findCoursePageId(courseName) {
  const res = await notion.databases.query({
    database_id: COURSE_PLANNER_DB,
    filter: {
      property: "Canvas Course Name",
      rich_text: { equals: courseName },
    },
  });
  return res.results.length ? res.results[0].id : null;
}

export default async function handler(req, res) {
  try {
    console.log("🔁 Starting sync-resources-hcc");

    const courses = await fetchAllPages(`${canvasConfig.baseUrl}/api/v1/courses`, canvasConfig.token);
    let created = 0;
    let updated = 0;

    for (const course of courses) {
      if (!course.name || !course.id || course.workflow_state !== "available") continue;

      const coursePageId = await findCoursePageId(course.name);
      if (!coursePageId) continue;

      const modules = await fetchModules(course);
      for (const module of modules) {
        const items = await fetchModuleItems(course, module);

        for (const item of items) {
          const content = await fetchAndParseContent(item);

          const notionQuery = await notion.databases.query({
            database_id: MODULE_CONTENT_DB_ID,
            filter: {
              property: "Canvas Module Item ID",
              rich_text: { equals: item.id.toString() },
            },
          });

          const props = {
            Name: { title: [{ text: { content: item.title || "Untitled" } }] },
            "Canvas Module Item ID": { rich_text: [{ text: { content: item.id.toString() } }] },
            Course: { relation: [{ id: coursePageId }] },
            Module: { rich_text: [{ text: { content: module.name || "(No Module)" } }] },
            Summary: content ? { rich_text: [{ text: { content } }] } : undefined,
            "Auto-generated": { checkbox: true },
            "Last Synced": { date: { start: new Date().toISOString() } },
            Type: { select: { name: item.type || "Item" } },
          };

          if (item.html_url || item.external_url) {
            props.Link = { url: item.external_url || item.html_url };
          }

          if (notionQuery.results.length > 0) {
            await notion.pages.update({
              page_id: notionQuery.results[0].id,
              properties: props,
            });
            updated++;
          } else {
            await notion.pages.create({
              parent: { database_id: MODULE_CONTENT_DB_ID },
              properties: props,
            });
            created++;
          }
        }
      }
    }

    res.status(200).send(`✅ HCC Resources: ${created} created, ${updated} updated`);
  } catch (err) {
    console.error("❌ sync-resources-hcc failed:", err.message);
    res.status(500).send("❌ sync-resources-hcc failed");
  }
}
