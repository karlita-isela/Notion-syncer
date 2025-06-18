// ==============================
// sync-resources-cellbio.js
// ==============================

import { Client } from "@notionhq/client";
import fetch from "node-fetch";
import "dotenv/config";

const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

const COURSE_NAME = "MCELLBI X116";
const COURSE_LABEL = "Cell Bio";
const CANVAS_BASE = process.env.CANVAS_2_API_BASE;
const CANVAS_TOKEN = process.env.CANVAS_2_API_TOKEN;
const COURSE_RESOURCE_DB = process.env.NOTION_COURSE_RESOURCE_DB_ID;
const COURSE_PLANNER_DB = process.env.COURSE_PLANNER_DB;

// ==============================
// Fetch Canvas Courses
// ==============================
async function getCanvasCourses() {
  const res = await fetch(`${CANVAS_BASE}/api/v1/courses`, {
    headers: { Authorization: `Bearer ${CANVAS_TOKEN}` },
  });
  return res.json();
}

// ==============================
// Get Notion Course Page ID
// ==============================
async function findCoursePageId() {
  const response = await notion.databases.query({
    database_id: COURSE_PLANNER_DB,
    filter: {
      property: "Name",
      rich_text: {
        contains: COURSE_NAME,
      },
    },
  });

  if (response.results.length === 0) {
    console.error(`❌ Course '${COURSE_NAME}' not found in Notion Course Planner DB`);
    return null;
  }

  return response.results[0].id;
}

// ==============================
// Fetch Canvas Modules + Items
// ==============================
async function getCanvasModuleItems(canvasCourseId) {
  const modulesRes = await fetch(
    `${CANVAS_BASE}/api/v1/courses/${canvasCourseId}/modules?include=items&per_page=100`,
    { headers: { Authorization: `Bearer ${CANVAS_TOKEN}` } }
  );
  return modulesRes.json();
}

// ==============================
// Main Sync Logic
// ==============================
(async () => {
  console.log("📡 Starting Cell Bio Resource Sync...");

  const coursePageId = await findCoursePageId();
  if (!coursePageId) return;

  const canvasCourses = await getCanvasCourses();
  const course = canvasCourses.find((c) => c.name.startsWith(COURSE_NAME));
  if (!course) {
    console.error(`❌ Canvas course '${COURSE_NAME}' not found`);
    return;
  }

  const modules = await getCanvasModuleItems(course.id);
  if (!modules || modules.length === 0) {
    console.warn(`⚠️ No modules found for Canvas course: ${COURSE_NAME}`);
    return;
  }

  let syncedCount = 0;

  for (const module of modules) {
    const moduleName = module.name || "Untitled Module";

    for (const item of module.items || []) {
      const title = item.title || item.page_url || "Untitled";
      const canvasId = String(item.id);

      try {
        // Check if this item already exists in Notion
        const existing = await notion.databases.query({
          database_id: COURSE_RESOURCE_DB,
          filter: {
            property: "Canvas Module Item ID",
            rich_text: {
              equals: canvasId,
            },
          },
        });

        const props = {
          Name: {
            title: [{ type: "text", text: { content: title } }],
          },
          Type: {
            select: {
              name: item.type || "Link",
            },
          },
          Content: {
            rich_text: [{ type: "text", text: { content: item.title || "" } }],
          },
          Course: {
            relation: [{ id: coursePageId }],
          },
          Module: {
            rich_text: [{ type: "text", text: { content: moduleName } }],
          },
          Link: {
            url: item.html_url,
          },
          "Canvas Module Item ID": {
            rich_text: [{ type: "text", text: { content: canvasId } }],
          },
          "Last Synced": {
            date: { start: new Date().toISOString() },
          },
          "Auto-generated": {
            checkbox: true,
          },
        };

        if (existing.results.length > 0) {
          await notion.pages.update({
            page_id: existing.results[0].id,
            properties: props,
          });
          console.log(`♻️ Updated: ${title}`);
        } else {
          await notion.pages.create({
            parent: { database_id: COURSE_RESOURCE_DB },
            properties: props,
          });
          console.log(`✨ Created: ${title}`);
        }

        syncedCount++;
      } catch (err) {
        console.error(`❌ Error syncing "${title}":`, err.message);
      }
    }
  }

  console.log(`✅ Synced ${syncedCount} Cell Bio resources`);
})();
