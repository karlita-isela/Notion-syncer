// ==============================
// FILE: /api/sync-resources-cellbio.js
// ==============================

import { Client } from '@notionhq/client';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
const MODULE_CONTENT_DB_ID = process.env.NOTION_COURSE_RESOURCE_DB_ID;
const COURSE_PLANNER_DB = process.env.COURSE_PLANNER_DB;

const canvasConfig = {
  token: process.env.CANVAS_2_API_TOKEN,
  baseUrl: process.env.CANVAS_2_API_BASE,
  label: process.env.CANVAS_2_LABEL,
  courseName: 'MCELLBI X116 – Cell Biology' // Exact match for Cell Bio
};

// ==============================
// Helpers
// ==============================

async function fetchAllPages(url, token) {
  let results = [];
  let nextUrl = url;

  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    results = results.concat(data);

    const linkHeader = res.headers.get('link');
    const match = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : null;
  }

  return results;
}

async function fetchModules(baseUrl, courseId, token) {
  return await fetchAllPages(`${baseUrl}/api/v1/courses/${courseId}/modules`, token);
}

async function fetchModuleItems(baseUrl, courseId, moduleId, token) {
  return await fetchAllPages(
    `${baseUrl}/api/v1/courses/${courseId}/modules/${moduleId}/items`,
    token
  );
}

async function fetchAndParseModuleItemContent(item, token) {
  if (!item.url) return null;

  try {
    const response = await fetch(item.url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) return null;

    const html = await response.text();
    const $ = cheerio.load(html);
    const contentText = $("div.content, div.syllabus, div.lecture-content").text().trim();

    return contentText || null;
  } catch {
    return null;
  }
}

async function findCoursePageId(canvasCourseName) {
  const res = await notion.databases.query({
    database_id: COURSE_PLANNER_DB,
    filter: {
      property: "Canvas Course Name",
      rich_text: { equals: canvasCourseName },
    },
  });
  return res.results.length ? res.results[0].id : null;
}

// ==============================
// MAIN HANDLER
// ==============================

export default async function handler(req, res) {
  try {
    console.log("🔁 Cell Bio resource sync triggered");

    const allCourses = await fetchAllPages(`${canvasConfig.baseUrl}/api/v1/courses`, canvasConfig.token);
    const course = allCourses.find(c => c.name === canvasConfig.courseName);
    if (!course) throw new Error(`Course "${canvasConfig.courseName}" not found`);

    const coursePageId = await findCoursePageId(course.name);
    if (!coursePageId) throw new Error(`Notion page not found for course: ${course.name}`);

    const modules = await fetchModules(canvasConfig.baseUrl, course.id, canvasConfig.token);
    let resourceCount = 0;

    for (const module of modules) {
      const moduleItems = await fetchModuleItems(canvasConfig.baseUrl, course.id, module.id, canvasConfig.token);

      for (const item of moduleItems) {
        const contentText = await fetchAndParseModuleItemContent(item, canvasConfig.token);

        const notionQuery = await notion.databases.query({
          database_id: MODULE_CONTENT_DB_ID,
          filter: {
            property: "Canvas Module Item ID",
            rich_text: { equals: item.id.toString() },
          },
        });

        const pageProps = {
          Name: { title: [{ text: { content: item.title || "(Untitled Resource)" } }] },
          "Canvas Module Item ID": { rich_text: [{ text: { content: item.id.toString() } }] },
          Course: { relation: [{ id: coursePageId }] },
          Module: { rich_text: [{ text: { content: module.name || "(No Module)" } }] },
          "Type": item.type ? { select: { name: item.type } } : undefined,
          Summary: contentText ? { rich_text: [{ text: { content: contentText.slice(0, 2000) } }] } : undefined,
          "Last Synced": { date: { start: new Date().toISOString() } },
        };

        if (notionQuery.results.length > 0) {
          await notion.pages.update({
            page_id: notionQuery.results[0].id,
            properties: pageProps,
          });
          console.log(`♻️ Updated: ${item.title}`);
        } else {
          await notion.pages.create({
            parent: { database_id: MODULE_CONTENT_DB_ID },
            properties: {
              ...pageProps,
              "Auto-generated": { checkbox: true },
            },
          });
          console.log(`✨ Created: ${item.title}`);
        }

        resourceCount++;
      }
    }

    res.status(200).send(`✅ Synced ${resourceCount} Cell Bio resources`);
  } catch (err) {
    console.error("❌ sync-resources-cellbio failed:", err.message);
    res.status(500).send(`❌ sync-resources-cellbio failed: ${err.message}`);
  }
}
