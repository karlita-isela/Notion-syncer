import { Client } from '@notionhq/client';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

const MODULE_DB_ID = process.env.NOTION_COURSE_RESOURCE_DB_ID;
const COURSE_PLANNER_DB = process.env.COURSE_PLANNER_DB;

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
].filter(c => c.token && c.baseUrl);

async function fetchAllPages(url, token) {
  let results = [];
  let nextUrl = url;

  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    results = results.concat(data);
    const linkHeader = res.headers.get('link');
    const match = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : null;
  }

  return results;
}

async function fetchModuleItemText(url, token) {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    const text = $('div.content, div.syllabus, div.lecture-content').text().trim();
    return text?.slice(0, 2000) || null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    let count = 0;

    for (const config of canvasConfigs) {
      const courses = await fetchAllPages(`${config.baseUrl}/api/v1/courses`, config.token);

      for (const course of courses) {
        if (!course.name || !course.id || course.workflow_state !== 'available') continue;

        const modules = await fetchAllPages(
          `${config.baseUrl}/api/v1/courses/${course.id}/modules`,
          config.token
        );

        for (const mod of modules) {
          const items = await fetchAllPages(
            `${config.baseUrl}/api/v1/courses/${course.id}/modules/${mod.id}/items`,
            config.token
          );

          for (const item of items) {
            const content = await fetchModuleItemText(item.url, config.token);
            const notionQuery = await notion.databases.query({
              database_id: MODULE_DB_ID,
              filter: {
                property: 'Canvas Module Item ID',
                rich_text: { equals: item.id.toString() },
              },
            });

            const props = {
              Name: { title: [{ text: { content: item.title || 'Untitled' } }] },
              "Canvas Module Item ID": {
                rich_text: [{ text: { content: item.id.toString() } }],
              },
              Course: { rich_text: [{ text: { content: course.name } }] },
              Module: { rich_text: [{ text: { content: mod.name || '(No Module)' } }] },
              Link: item.external_url
                ? { url: item.external_url }
                : item.html_url
                ? { url: item.html_url }
                : undefined,
              Summary: content
                ? { rich_text: [{ text: { content } }] }
                : undefined,
              "Last Synced": { date: { start: new Date().toISOString() } },
              "Auto-generated": { checkbox: true },
            };

            if (notionQuery.results.length) {
              await notion.pages.update({
                page_id: notionQuery.results[0].id,
                properties: props,
              });
              console.log(`♻️ Updated ${item.title}`);
            } else {
              await notion.pages.create({
                parent: { database_id: MODULE_DB_ID },
                properties: props,
              });
              console.log(`✨ Created ${item.title}`);
            }

            count++;
          }
        }
      }
    }

    res.status(200).send(`✅ Synced ${count} course resources.`);
  } catch (err) {
    console.error("❌ Resource sync failed:", err.message);
    res.status(500).send("❌ Resource sync failed");
  }
}
