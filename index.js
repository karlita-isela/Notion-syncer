const express = require("express");
const { Client } = require("@notionhq/client");
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const cheerio = require("cheerio");
require("dotenv").config();

const app = express();
const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

// Load env variables
const NOTION_DB_ID = process.env.NOTION_DB_ID;
const COURSE_PLANNER_DB = process.env.COURSE_PLANNER_DB;
const MODULE_CONTENT_DB_ID = process.env.NOTION_COURSE_RESOURCE_DB_ID;

const requiredEnvVars = [
  "NOTION_API_TOKEN",
  "NOTION_DB_ID",
  "COURSE_PLANNER_DB",
  "NOTION_COURSE_RESOURCE_DB_ID",
  "CANVAS_1_API_TOKEN",
  "CANVAS_1_API_BASE",
  "CANVAS_1_LABEL",
];

requiredEnvVars.forEach((envVar) => {
  if (!process.env[envVar]) {
    console.error(`⚠️ Environment variable ${envVar} is missing!`);
  }
});

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

// Helper functions
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

function detectModule(name) {
  const lowered = name.toLowerCase();
  const chapterMatch = lowered.match(/ch(?:apter)?\.?\s*(\d+)/);
  if (chapterMatch) return `Chapter ${chapterMatch[1]}`;
  const moduleMatch = lowered.match(/(m|module)\s?-?\s?(\d+)/);
  if (moduleMatch) return `Module ${moduleMatch[2]}`;
  return "Uncategorized";
}

function detectSubmissionStatus(assignment) {
  if (assignment.submission && assignment.submission.submitted_at) {
    const submittedAt = new Date(assignment.submission.submitted_at);
    const dueAt = assignment.due_at ? new Date(assignment.due_at) : null;
    if (dueAt && submittedAt > dueAt) return "⏰ Delayed AF";
    else return "✨ Dominated";
  } else if (assignment.due_at && new Date() > new Date(assignment.due_at)) {
    return "💀 Never Gave";
  } else {
    return "🧠 Manifesting Productivity";
  }
}

const fetchAllPages = async (url, token) => {
  let results = [];
  let nextUrl = url;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) throw new Error(`Canvas API error: ${response.status} ${response.statusText}`);

    const data = await response.json();
    results = results.concat(data);

    const linkHeader = response.headers.get("link");
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      nextUrl = nextMatch ? nextMatch[1] : null;
    } else {
      nextUrl = null;
    }
  }

  return results;
};

function cleanAssignmentName(name, type) {
  let cleanedName = name;
  if (type && !["exam", "quiz"].includes(type.toLowerCase())) {
    const typeLower = type.toLowerCase();
    const regexType = new RegExp(`^${typeLower}:?\\s*`, "i");
    cleanedName = cleanedName.replace(regexType, "");
    const regexModuleChapter = /^(m(odule)?\s*\d+|ch(apter)?\.?\s*\d+)\s*[-:]?\s*/i;
    cleanedName = cleanedName.replace(regexModuleChapter, "");
  }
  return cleanedName.trim();
}

function renameShortAnswerWorksheet(name) {
  const regex = /^M\d+\s+Worksheet:\s+Short-Answer Questions$/i;
  if (regex.test(name)) return "Quiz (Short Answer)";
  return name;
}

async function fetchModules(baseUrl, course, token) {
  const modules = await fetchAllPages(`${baseUrl}/api/v1/courses/${course.id}/modules`, token);
  console.log(`   ➤ Found ${modules.length} modules for course ${course.name}`);
  return modules;
}

async function fetchModuleItems(baseUrl, course, module, token) {
  const moduleItems = await fetchAllPages(`${baseUrl}/api/v1/courses/${course.id}/modules/${module.id}/items`, token);
  console.log(`      ➤ Found ${moduleItems.length} items in module "${module.name}"`);
  return moduleItems;
}

async function fetchAndParseModuleItemContent(course, item, token) {
  if (!item.url) {
    console.log(`         ⚠️ No URL for module item "${item.title}"`);
    return null;
  }

  try {
    const response = await fetch(item.url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      console.log(`         ⚠️ Failed to fetch module item content: ${response.status} ${response.statusText}`);
      return null;
    }

    const html = await response.text();

    const $ = cheerio.load(html);
    const contentText = $("div.content, div.syllabus, div.lecture-content").text().trim();

    return contentText || null;
  } catch (error) {
    console.error(`         ❌ Error fetching/parsing module item content: ${error.message}`);
    return null;
  }
}

// --- Sync route ---
app.get("/sync", async (req, res) => {
  console.log("SYNC ROUTE HIT");

  let totalCreated = 0;
  let totalUpdated = 0;

  for (const config of canvasConfigs) {
    console.log(`🔍 Syncing from ${config.label}...`);

    try {
      const courses = await fetchAllPages(`${config.baseUrl}/api/v1/courses`, config.token);
      console.log(`   ➤ Got ${courses.length} courses`);

      for (const course of courses) {
        if (!course.name || !course.id) continue;

        console.log(`📘 Course: ${course.name} (${course.id})`);

        try {
          const assignments = await fetchAllPages(`${config.baseUrl}/api/v1/courses/${course.id}/assignments`, config.token);
          console.log(`   ➤ Found ${assignments.length} assignments for ${course.name}`);

          let modules = [];
          try {
            modules = await fetchModules(config.baseUrl, course, config.token);
          } catch (modErr) {
            console.error(`      ❌ Failed to fetch modules for ${course.name}: ${modErr.message}`);
          }

          if (modules.length === 0) {
            console.log(`      ⚠️ No modules found for ${course.name}, syncing assignments as standalone resources`);

            for (const assignment of assignments) {
              try {
                const existingResource = await notion.databases.query({
                  database_id: MODULE_CONTENT_DB_ID,
                  filter: {
                    property: "Canvas Assignment ID",
                    rich_text: {
                      equals: assignment.id.toString(),
                    },
                  },
                });

                const detectedType = detectTypeFromName(assignment.name);
                let cleanName = cleanAssignmentName(assignment.name, detectedType);
                cleanName = renameShortAnswerWorksheet(cleanName);

                const coursePageId = await findCoursePageId(course.name);
                if (!coursePageId) {
                  console.log(`         ⚠️ No matching Notion course page for "${course.name}", skipping resource.`);
                  continue;
                }

                if (existingResource.results.length > 0) {
                  const pageId = existingResource.results[0].id;
                  await notion.pages.update({
                    page_id: pageId,
                    properties: {
                      Title: { title: [{ text: { content: cleanName } }] },
                      Type: { select: { name: detectedType } },
                      Course: { relation: [{ id: coursePageId }] },
                      "Canvas Assignment ID": { rich_text: [{ text: { content: assignment.id.toString() } }] },
                      Content: { rich_text: [{ text: { content: "" } }] },
                    },
                  });
                  totalUpdated++;
                  console.log(`♻️ Updated resource "${assignment.name}" (fallback)`);
                } else {
                  await notion.pages.create({
                    parent: { database_id: MODULE_CONTENT_DB_ID },
                    properties: {
                      Title: { title: [{ text: { content: cleanName } }] },
                      Type: { select: { name: detectedType } },
                      Course: { relation: [{ id: coursePageId }] },
                      "Canvas Assignment ID": { rich_text: [{ text: { content: assignment.id.toString() } }] },
                      Content: { rich_text: [{ text: { content: "" } }] },
                    },
                  });
                  totalCreated++;
                  console.log(`✅ Created resource "${assignment.name}" (fallback)`);
                }
              } catch (err) {
                console.error(`❌ Failed resource sync for "${assignment.name}": ${err.message}`);
              }
            }
          } else {
            for (const module of modules) {
              let moduleItems = [];
              try {
                moduleItems = await fetchModuleItems(config.baseUrl, course, module, config.token);
              } catch (itemErr) {
                console.error(`         ❌ Failed to fetch module items for module ${module.name}: ${itemErr.message}`);
              }

              for (const item of moduleItems) {
                if (!item.url) continue;

                try {
                  const contentText = await fetchAndParseModuleItemContent(course, item, config.token);
                  if (!contentText) continue;

                  const existingResource = await notion.databases.query({
                    database_id: MODULE_CONTENT_DB_ID,
                    filter: {
                      property: "Module Item ID",
                      rich_text: {
                        equals: item.id.toString(),
                      },
                    },
                  });

                  const coursePageId = await findCoursePageId(course.name);
                  if (!coursePageId) {
                    console.log(`         ⚠️ No matching Notion course page for "${course.name}", skipping module content.`);
                    continue;
                  }

                  if (existingResource.results.length > 0) {
                    const pageId = existingResource.results[0].id;
                    await notion.pages.update({
                      page_id: pageId,
                      properties: {
                        Content: { rich_text: [{ text: { content: contentText } }] },
                        Module: { rich_text: [{ text: { content: module.name } }] },
                        Course: { relation: [{ id: coursePageId }] },
                        Type: { select: { name: item.type || "Module Item" } },
                        "Module Item ID": { rich_text: [{ text: { content: item.id.toString() } }] },
                      },
                    });
                    totalUpdated++;
                    console.log(`♻️ Updated module content "${item.title}"`);
                  } else {
                    await notion.pages.create({
                      parent: { database_id: MODULE_CONTENT_DB_ID },
                      properties: {
                        Title: { title: [{ text: { content: item.title } }] },
                        Module: { rich_text: [{ text: { content: module.name } }] },
                        Course: { relation: [{ id: coursePageId }] },
                        Type: { select: { name: item.type || "Module Item" } },
                        "Module Item ID": { rich_text: [{ text: { content: item.id.toString() } }] },
                        Content: { rich_text: [{ text: { content: contentText } }] },
                      },
                    });
                    totalCreated++;
                    console.log(`✅ Created module content "${item.title}"`);
                  }
                } catch (contentErr) {
                  console.error(`❌ Failed module content sync for "${item.title}": ${contentErr.message}`);
                }
              }
            }
          }

          // Sync assignments (create or update)
          for (const assignment of assignments) {
            try {
              const existingAssignment = await notion.databases.query({
                database_id: NOTION_DB_ID,
                filter: {
                  property: "Canvas Assignment ID",
                  rich_text: {
                    equals: assignment.id.toString(),
                  },
                },
              });

              const detectedType = detectTypeFromName(assignment.name);
              let cleanName = cleanAssignmentName(assignment.name, detectedType);
              cleanName = renameShortAnswerWorksheet(cleanName);

              const coursePageId = await findCoursePageId(course.name);
              if (!coursePageId) {
                console.log(`⚠️ No matching Notion course page for "${course.name}", skipping assignment.`);
                continue;
              }

              if (existingAssignment.results.length > 0) {
                const pageId = existingAssignment.results[0].id;
                await notion.pages.update({
                  page_id: pageId,
                  properties: {
                    Name: { title: [{ text: { content: cleanName } }] },
                    Type: { select: { name: detectedType } },
                    Due: assignment.due_at ? { date: { start: assignment.due_at } } : undefined,
                    "Chapter/Module": { rich_text: [{ text: { content: detectModule(assignment.name) } }] },
                    "Submission Status": { multi_select: [{ name: detectSubmissionStatus(assignment) }] },
                    Course: { relation: [{ id: coursePageId }] },
                    "Canvas Assignment ID": { rich_text: [{ text: { content: assignment.id.toString() } }] },
                  },
                });
                totalUpdated++;
                console.log(`♻️ Updated assignment "${assignment.name}"`);
              } else {
                await notion.pages.create({
                  parent: { database_id: NOTION_DB_ID },
                  properties: {
                    Name: { title: [{ text: { content: cleanName } }] },
                    Type: { select: { name: detectedType } },
                    Due: assignment.due_at ? { date: { start: assignment.due_at } } : undefined,
                    "Chapter/Module": { rich_text: [{ text: { content: detectModule(assignment.name) } }] },
                    "Submission Status": { multi_select: [{ name: detectSubmissionStatus(assignment) }] },
                    Course: { relation: [{ id: coursePageId }] },
                    "Canvas Assignment ID": { rich_text: [{ text: { content: assignment.id.toString() } }] },
                  },
                });
                totalCreated++;
                console.log(`✅ Created assignment "${assignment.name}"`);
              }
            } catch (assignmentErr) {
              console.error(`❌ Failed assignment sync for "${assignment.name}": ${assignmentErr.message}`);
            }
          }
        } catch (courseErr) {
          console.error(`❌ Failed to sync course ${course.name}: ${courseErr.message}`);
        }
      }
    } catch (err) {
      console.error(`❌ Error syncing ${config.label}:`, err.message);
    }
  }

  res.send(`✅ Synced ${totalCreated} assignments and ${totalUpdated} resources to Notion!`);
});

// Welcome route
app.get("/", (req, res) => {
  res.send("👋 Welcome to your Notion Class Importer!");
});

// Course list route
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

// Test Canvas route
app.get("/test-canvas", async (req, res) => {
  try {
    const response = await fetch(`${canvasConfigs[0].baseUrl}/api/v1/courses`, {
      headers: { Authorization: `Bearer ${canvasConfigs[0].token}` },
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("Environment Variables:");
  console.log({
    NOTION_API_TOKEN: !!process.env.NOTION_API_TOKEN,
    NOTION_DB_ID: !!process.env.NOTION_DB_ID,
    COURSE_PLANNER_DB: !!process.env.COURSE_PLANNER_DB,
    NOTION_COURSE_RESOURCE_DB_ID: !!process.env.NOTION_COURSE_RESOURCE_DB_ID,
    CANVAS_1_API_TOKEN: !!process.env.CANVAS_1_API_TOKEN,
    CANVAS_1_API_BASE: process.env.CANVAS_1_API_BASE,
  });
});