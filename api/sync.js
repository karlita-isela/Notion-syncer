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

function detectSubmissionStatus(assignment, currentLabel) {
  const submission = assignment?.submission;
  const hasGrade = submission?.score != null;
  const isLate = submission?.late;
  const isSubmitted = submission?.submitted_at;
  const isMissing = submission?.missing;
  const dueAt = assignment?.due_at;
  const now = new Date().toISOString();

  if (
    currentLabel === "💀 Never Gave" &&
    !isSubmitted &&
    !hasGrade &&
    dueAt &&
    now > dueAt
  ) return currentLabel;

  if (isSubmitted) return "✨ Dominated";
  if (isLate || isMissing) return "⏰ Delayed AF";
  if (!submission) return "🧠 Manifesting Productivity";
  return currentLabel || "🧠 Manifesting Productivity";
}

function buildGradeString(submission, assignment) {
  if (!submission || submission.score == null || assignment.points_possible == null) {
    return "Not Graded";
  }
  return `${submission.score} / ${assignment.points_possible}`;
}

function detectClosedStatus(assignment) {
  return assignment?.closed_for_submissions ? "Yes" : "No";
}

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

async function findCoursePageId(courseName, dbId) {
  const res = await notion.databases.query({
    database_id: dbId,
    filter: {
      property: "Canvas Course Name",
      rich_text: { equals: courseName },
    },
  });
  return res.results.length ? res.results[0].id : null;
}

// ==============================
// VERCEL HANDLER ENTRY POINT
// ==============================
export default async function handler(req, res) {
  try {
    console.log("🧠 Vercel sync triggered");
    let totalCreated = 0;
    let totalUpdated = 0;

    const NOTION_DB_ID = process.env.NOTION_DB_ID;
    const COURSE_PLANNER_DB = process.env.COURSE_PLANNER_DB;

    for (const config of canvasConfigs) {
      const courses = await fetchAllPages(`${config.baseUrl}/api/v1/courses`, config.token);
      for (const course of courses) {
        if (!course.name || !course.id || course.workflow_state !== "available") continue;

        console.log(`📘 Syncing course: ${course.name} (${course.id})`);

        const coursePageId = await findCoursePageId(course.name, COURSE_PLANNER_DB);
        if (!coursePageId) {
          console.log(`⚠️ Skipping ${course.name} — Notion page not found`);
          continue;
        }

        const assignments = await fetchAllPages(
          `${config.baseUrl}/api/v1/courses/${course.id}/assignments?include[]=submission`,
          config.token
        );
        console.log(`   ➤ Found ${assignments.length} assignments`);

        for (const assignment of assignments) {
          const notionQuery = await notion.databases.query({
            database_id: NOTION_DB_ID,
            filter: {
              property: "Canvas Assignment ID",
              rich_text: { equals: assignment.id.toString() },
            },
          });

          const newDue = assignment.due_at ? { date: { start: assignment.due_at } } : undefined;
          const newGrade = buildGradeString(assignment.submission, assignment);
          const newStatus = detectSubmissionStatus(assignment);
          const newClosed = detectClosedStatus(assignment);

          if (notionQuery.results.length > 0) {
            const page = notionQuery.results[0];
            await notion.pages.update({
              page_id: page.id,
              properties: {
                Due: newDue,
                Grade: { rich_text: [{ text: { content: newGrade } }] },
                "Submission Status": { multi_select: [{ name: newStatus }] },
                Closed: { select: { name: newClosed } },
                "Last Synced": { date: { start: new Date().toISOString() } },
              },
            });
            console.log(`♻️ Updated: "${assignment.name}"`);
            totalUpdated++;
          } else {
            await notion.pages.create({
              parent: { database_id: NOTION_DB_ID },
              properties: {
                Name: { title: [{ text: { content: assignment.name || "Untitled" } }] },
                "Canvas Assignment ID": { rich_text: [{ text: { content: assignment.id.toString() } }] },
                Due: newDue,
                Grade: { rich_text: [{ text: { content: newGrade } }] },
                "Submission Status": { multi_select: [{ name: newStatus }] },
                Closed: { select: { name: newClosed } },
                Course: { relation: [{ id: coursePageId }] },
                "Auto-generated": { checkbox: true },
                "Last Synced": { date: { start: new Date().toISOString() } },
                "Plot Twist": { multi_select: [{ name: "✨ Just Landed" }] },
              },
            });
            console.log(`✅ Created: "${assignment.name}"`);
            totalCreated++;
          }
        }
      }
    }

    res.status(200).send(`✅ Synced ${totalCreated} new + ${totalUpdated} updated assignments`);
  } catch (err) {
    console.error("❌ Sync failed:", err.message);
    res.status(500).send("❌ Sync failed");
  }
}
