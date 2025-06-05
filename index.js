const express = require("express");
const { Client } = require("@notionhq/client");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
require("dotenv").config();

const app = express();
const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

const NOTION_DB_ID = process.env.NOTION_DB_ID;
const COURSE_PLANNER_DB = process.env.COURSE_PLANNER_DB;

// Canvas accounts to sync
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

// 🔍 Find Notion course page
async function findCoursePageId(canvasCourseName) {
  const res = await notion.databases.query({
    database_id: COURSE_PLANNER_DB,
    filter: {
      property: "Canvas Course Name",
      rich_text: {
        equals: canvasCourseName,
      },
    },
  });

  return res.results.length ? res.results[0].id : null;
}

// 🎯 Type detector
function detectTypeFromName(name) {
  const lowered = name.toLowerCase();
  if (lowered.includes("quiz")) return "Quiz";
  if (lowered.includes("exam") || lowered.includes("test")) return "Exam";
  if (lowered.includes("discussion")) return "Discussion";
  if (lowered.includes("lecture")) return "Lecture";
  if (lowered.includes("extra credit")) return "Extra Credit";
  if (lowered.includes("reading")) return "Reading";
  if (lowered.includes("animation")) return "Animation";
  if (lowered.includes("chatgpt")) return "ChatGPT";
  if (lowered.includes("worksheet")) return "Worksheet";
  if (lowered.includes("homework") || lowered.includes("assignment")) return "Homework";
  return "Worksheet";
}

// 🧠 Module detector
function detectModule(name) {
  const match = name.match(/(M|Module|Ch|Chapter)\s?-?\s?(\d+)/i);
  return match ? `Module ${match[2]}` : "Uncategorized";
}

// 🔍 Debug route: fetch Canvas courses
app.get("/courses", async (req, res) => {
  const allCourses = [];

  for (const config of canvasConfigs) {
    try {
      const response = await fetch(`${config.baseUrl}/api/v1/courses`, {
        headers: {
          Authorization: `Bearer ${config.token}`,
        },
      });
      const courses = await response.json();
      allCourses.push({
        label: config.label,
        courses,
      });
    } catch (error) {
      allCourses.push({
        label: config.label,
        error: error.message,
      });
    }
  }

  res.json(allCourses);
});

// 🔁 SYNC route
app.get("/sync", async (req, res) => {
  let totalCreated = 0;

  for (const config of canvasConfigs) {
    console.log(`🔍 Syncing from ${config.label}...`);

    try {
      const coursesRes = await fetch(`${config.baseUrl}/api/v1/courses`, {
        headers: { Authorization: `Bearer ${config.token}` },
      });
      const courses = await coursesRes.json();

      for (const course of courses) {
        if (!course.name || !course.id) continue;
        console.log(`📘 Course: ${course.name} (ID: ${course.id})`);

        const assignmentsRes = await fetch(
          `${config.baseUrl}/api/v1/courses/${course.id}/assignments`,
          {
            headers: { Authorization: `Bearer ${config.token}` },
          }
        );
        const assignments = await assignmentsRes.json();

        console.log(`   ➤ Found ${assignments.length} assignments`);

        for (const assignment of assignments) {
          console.log(`      📝 ${assignment.name}`);

          const coursePageId = await findCoursePageId(course.name);
          if (!coursePageId) {
            console.log(`         ⚠️ No matching Notion course page for "${course.name}"`);
          }

          try {
            await notion.pages.create({
              parent: { database_id: NOTION_DB_ID },
              properties: {
                Name: {
                  title: [{ text: { content: assignment.name } }],
                },
                Due: assignment.due_at
                  ? { date: { start: assignment.due_at } }
                  : undefined,
                Type: {
                  select: { name: detectTypeFromName(assignment.name) },
                },
                "Chapter/Module": {
                  rich_text: [
                    { text: { content: detectModule(assignment.name) } },
                  ],
                },
                Status: {
                  select: { name: assignment.workflow_state || "unknown" },
                },
                ...(coursePageId && {
                  Course: {
                    relation: [{ id: coursePageId }],
                  },
                }),
              },
            });

            totalCreated++;
            console.log(`         ✅ Synced "${assignment.name}"`);
          } catch (createErr) {
            console.error(`         ❌ Failed to create Notion page: ${createErr.message}`);
          }
        }
      }
    } catch (err) {
      console.error(`❌ Error syncing ${config.label}:`, err.message);
    }
  }

  res.send(`✅ Synced ${totalCreated} assignments to Notion!`);
});

// 🔓 Welcome route
app.get("/", (req, res) => {
  res.send("👋 Welcome to your Notion Class Importer (Replit edition)!");
});

// 📚 GET list of Canvas courses
app.get("/courses", async (req, res) => {
  const courseList = [];

  for (const config of canvasConfigs) {
    try {
      const coursesRes = await fetch(`${config.baseUrl}/api/v1/courses`, {
        headers: { Authorization: `Bearer ${config.token}` },
      });
      const courses = await coursesRes.json();

      for (const course of courses) {
        courseList.push({
          id: course.id,
          name: course.name,
          label: config.label,
        });
      }
    } catch (err) {
      console.error(`❌ Error fetching courses for ${config.label}:`, err.message);
    }
  }

  res.json(courseList);
});

// 🧠 Server start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});