// ==============================
// PART 1a – Imports & Setup
// ==============================
const express = require("express");
const { Client } = require("@notionhq/client");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const cheerio = require("cheerio");
require("dotenv").config();

const app = express();
const os = require("os");

// ===============================
// PART 1b – Environment Variables
// ==============================
const NOTION_API_TOKEN = process.env.NOTION_API_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DB_ID;
const COURSE_PLANNER_DB = process.env.COURSE_PLANNER_DB;
const MODULE_CONTENT_DB_ID = process.env.NOTION_COURSE_RESOURCE_DB_ID;
const ERROR_LOG_DB_ID = process.env.NOTION_ERROR_LOG_DB_ID;

const CANVAS_1_API_TOKEN = process.env.CANVAS_1_API_TOKEN;
const CANVAS_1_API_BASE = process.env.CANVAS_1_API_BASE;
const CANVAS_1_LABEL = process.env.CANVAS_1_LABEL;

const CANVAS_2_API_TOKEN = process.env.CANVAS_2_API_TOKEN;
const CANVAS_2_API_BASE = process.env.CANVAS_2_API_BASE;
const CANVAS_2_LABEL = process.env.CANVAS_2_LABEL;

// ==============================
// PART 1c – Environment Variable Validation
// ==============================
const requiredEnvVars = [
  "NOTION_API_TOKEN",
  "NOTION_DB_ID",
  "COURSE_PLANNER_DB",
  "NOTION_COURSE_RESOURCE_DB_ID",
  "ERROR_LOG_DB_ID",
  "CANVAS_1_API_TOKEN",
  "CANVAS_1_API_BASE",
  "CANVAS_1_LABEL",
  "CANVAS_2_API_TOKEN",
  "CANVAS_2_API_BASE",
  "CANVAS_2_LABEL",
];

requiredEnvVars.forEach((envVar) => {
  if (!process.env[envVar]) {
    console.warn(`⚠️ Environment variable ${envVar} is missing!`);
  } else {
    console.log(`✅ Environment variable ${envVar} loaded.`);
  }
});

// ==============================
// PART 1d – Initialize Notion Client and Canvas Configs
// ==============================
const notion = new Client({ auth: NOTION_API_TOKEN });

const canvasConfigs = [
  {
    token: CANVAS_1_API_TOKEN,
    baseUrl: CANVAS_1_API_BASE,
    label: CANVAS_1_LABEL,
  },
  {
    token: CANVAS_2_API_TOKEN,
    baseUrl: CANVAS_2_API_BASE,
    label: CANVAS_2_LABEL,
  },
].filter((c) => c.token && c.baseUrl);

// ==============================
// PART 1e – Helper: fetchAllPages
// ==============================
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

// ==============================
// PART 1f – Helper: fetchModules
// ==============================
async function fetchModules(baseUrl, course, token) {
  const modules = await fetchAllPages(
    `${baseUrl}/api/v1/courses/${course.id}/modules`,
    token
  );
  console.log(`   ➤ Found ${modules.length} modules for ${course.name}`);
  return modules;
}

// ==============================
// PART 1g – Helper: fetchModuleItems
// ==============================
async function fetchModuleItems(baseUrl, course, module, token) {
  const moduleItems = await fetchAllPages(
    `${baseUrl}/api/v1/courses/${course.id}/modules/${module.id}/items`,
    token
  );
  const moduleName = module?.name || "(unknown)";
  console.log(`      ➤ Found ${moduleItems.length} items in module "${moduleName}"`);
  return moduleItems;
}
// ==============================
// PART 1h – Helper: fetch and parse module item content
// ==============================
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

// ==============================
// PART 1i – Helper: findCoursePageId
// ==============================
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
// PART 1j – Initialize course page cache
// ==============================
const coursePageMap = new Map();

// ==============================
// PART 1k – Helper: detectSubmissionStatus
// ==============================
function detectSubmissionStatus(assignment, currentLabel) {
  const submission = assignment?.submission;
  const hasGrade = submission?.score != null;
  const isLate = submission?.late;
  const isSubmitted = submission?.submitted_at;
  const isMissing = submission?.missing;
  const dueAt = assignment?.due_at;
  const now = new Date().toISOString();

  // 💀 Never Gave stays if truly untouched after deadline
  if (
    currentLabel === "💀 Never Gave" &&
    !isSubmitted &&
    !hasGrade &&
    dueAt &&
    now > dueAt
  ) {
    return currentLabel;
  }

  if (isSubmitted) {
    return "✨ Dominated";
  }

  if (isLate || isMissing) {
    return "⏰ Delayed AF";
  }

  if (!submission) {
    return "🧠 Manifesting Productivity";
  }

  return currentLabel || "🧠 Manifesting Productivity";
}

// ==============================
// PART 1m – Helper: getSystemStats
// ==============================
function getSystemStats() {
  const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
  const usedMemMB = Math.round((os.totalmem() - os.freemem()) / 1024 / 1024);

  const uptimeSec = Math.floor(process.uptime());
  const uptimeMin = Math.floor(uptimeSec / 60);
  const uptimeHr = Math.floor(uptimeMin / 60);
  const uptimeStr = `${uptimeHr}h ${uptimeMin % 60}m`;

  return {
    usedMemory: `${usedMemMB} MB`,
    totalMemory: `${totalMemMB} MB`,
    uptime: uptimeStr,
  };
}

// ==============================
// PART 1l – Helper: logSyncErrorToNotion
// ==============================
async function logSyncErrorToNotion(source, message, assignment = null, courseName = null) {
  try {
    await notion.pages.create({
      parent: { database_id: ERROR_LOG_DB_ID },
      properties: {
        Name: {
          title: [{ text: { content: `Error: ${assignment || source}` } }],
        },
        Date: { date: { start: new Date().toISOString() } },
        Source: { rich_text: [{ text: { content: source } }] },
        "Error Message": { rich_text: [{ text: { content: message } }] },
        "Assignment Name": assignment
          ? { rich_text: [{ text: { content: assignment } }] }
          : undefined,
        "Canvas Course": courseName
          ? { rich_text: [{ text: { content: courseName } }] }
          : undefined,
        Resolved: { checkbox: false },
      },
    });
  } catch (err) {
    console.error("❌ Failed to log error to Notion:", err.message);
  }
}

          // ==============================
          // PART 2a – SYNC Route Setup (Full Block)
          // ==============================
          app.get("/sync", async (req, res) => {
            console.log("SYNC ROUTE HIT");
            console.log("🕒 Auto-sync triggered by EasyCron");

            let totalCreated = 0;
            let totalUpdated = 0;

            for (const config of canvasConfigs) {
              console.log(`🔍 Syncing from ${config.label}...`);

              try {
                const courses = await fetchAllPages(
                  `${config.baseUrl}/api/v1/courses`,
                  config.token
                );
                console.log(`   ➤ Got ${courses.length} courses`);

                for (const course of courses) {
                  if (!course.name || !course.id || course.workflow_state !== "available") continue;
                  console.log(`📘 Course: ${course.name} (${course.id})`);

                  const assignments = await fetchAllPages(
                    `${config.baseUrl}/api/v1/courses/${course.id}/assignments?include[]=submission`,
                    config.token
                  );
                  console.log(`   ➤ Found ${assignments.length} assignments`);

                  const coursePageId = await findCoursePageId(course.name);
                  if (!coursePageId) {
                    console.log(`   ⚠️ Skipping ${course.name}, Notion page not found`);
                    continue;
                  }

                  for (const assignment of assignments) {
                    try {
                      const cleanName = assignment.name?.trim() || "Untitled Assignment";

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
                      const plotTwist = [];
                      const acknowledged = false;

                      if (notionQuery.results.length > 0) {
                        // ==============================
                        // PART 2a.2 – Update Existing Assignment
                        // ==============================
                        const page = notionQuery.results[0];
                        const props = page.properties;

                        const currentDue = props?.Due?.date?.start;
                        const currentGrade = props?.Grade?.rich_text?.[0]?.text?.content;
                        const currentStatus = props?.["Submission Status"]?.multi_select?.[0]?.name;
                        const currentClosed = props?.Closed?.select?.name;
                        const currentPlotTwist = props?.["Plot Twist"]?.multi_select?.map((t) => t.name) || [];
                        const isAcknowledged = props?.Acknowledged?.checkbox || false;

                        const updatedProps = {
                          Name: { title: [{ text: { content: cleanName } }] },
                          "Canvas Assignment ID": {
                            rich_text: [{ text: { content: assignment.id.toString() } }],
                          },
                          Due: newDue,
                          Course: { relation: [{ id: coursePageId }] },
                          "Submission Status": {
                            multi_select: [{ name: newStatus }],
                          },
                          Grade: {
                            rich_text: [{ text: { content: newGrade } }],
                          },
                          Closed: {
                            select: {
                              name: newClosed ? "Yes" : "No"
                            }
                          },
                          "Auto-generated": { checkbox: true },
                          "Last Synced": { date: { start: new Date().toISOString() } },
                        };

                        if (newDue?.date?.start !== currentDue && !isAcknowledged) plotTwist.push("⚡ Deadline Remix");
                        if (newGrade !== currentGrade && !isAcknowledged) plotTwist.push("⚡ Deadline Remix");
                        if (newStatus !== currentStatus && !isAcknowledged) plotTwist.push("⚡ Deadline Remix");

                        let finalTwist = [...new Set([...currentPlotTwist, ...plotTwist])];
                        if (isAcknowledged) {
                          finalTwist = finalTwist.filter(
                            (tag) => tag !== "⚡ Deadline Remix" && tag !== "✨ Just Landed"
                          );
                        }

                        if (finalTwist.length > 0) {
                          updatedProps["Plot Twist"] = {
                            multi_select: finalTwist.map((tag) => ({ name: tag })),
                          };
                        }

                        if (newClosed !== currentClosed) {
                          updatedProps["Closed"] = {
                            select: {
                              name: newClosed ? "Yes" : "No"
                            }
                          };
                        }

                        await notion.pages.update({
                          page_id: page.id,
                          properties: updatedProps,
                        });

                        console.log(`♻️ Updated "${cleanName}"`);
                        totalUpdated++;
                      } else {
                        // ==============================
                        // PART 2a.3 – New Assignment Creation
                        // ==============================
                        await notion.pages.create({
                          parent: { database_id: NOTION_DB_ID },
                          properties: {
                            Name: { title: [{ text: { content: cleanName } }] },
                            Due: newDue,
                            Course: { relation: [{ id: coursePageId }] },
                            "Canvas Assignment ID": {
                              rich_text: [{ text: { content: assignment.id.toString() } }],
                            },
                            "Submission Status": {
                              multi_select: [{ name: newStatus }],
                            },
                            Grade: {
                              rich_text: [{ text: { content: newGrade } }],
                            },
                            Closed: {
                              select: {
                                name: newClosed ? "Yes" : "No"
                              }
                            },
                            "Plot Twist": {
                              multi_select: [{ name: "✨ Just Landed" }],
                            },
                            "Auto-generated": { checkbox: true },
                            "Last Synced": { date: { start: new Date().toISOString() } },
                          },
                        });

                        console.log(`✅ Created "${cleanName}"`);
                        totalCreated++;
                      }
                    } catch (err) {
                      console.error(`❌ Sync fail for "${assignment.name}": ${err.message}`);
                      await logSyncErrorToNotion(`sync: ${assignment.name}`, err.message);
                    }
                  }
                }
              } catch (err) {
                console.error(`❌ Error syncing ${config.label}:`, err.message);
              }
            }

            res.send(`✅ Synced ${totalCreated} new + ${totalUpdated} updated assignments`);
          });
// ==============================
// PART 2b – Canvas Module Content Sync
// ==============================
app.get("/sync-resources", async (req, res) => {
  console.log("🧠 Syncing course resource content...");
  let resourceCount = 0;

  for (const config of canvasConfigs) {
    try {
      const courses = await fetchAllPages(`${config.baseUrl}/api/v1/courses`, config.token);

      for (const course of courses) {
        if (!course.name || !course.id || course.workflow_state !== "available") continue;

        const modules = await fetchModules(config.baseUrl, course, config.token);

        for (const module of modules) {
          const moduleItems = await fetchModuleItems(config.baseUrl, course, module, config.token);

          for (const item of moduleItems) {
            try {
              const contentText = await fetchAndParseModuleItemContent(course, item, config.token);

              const notionQuery = await notion.databases.query({
                database_id: MODULE_CONTENT_DB_ID,
                filter: {
                  property: "Canvas Module Item ID",
                  rich_text: { equals: item.id.toString() },
                },
              });

              const pageProps = {
                Name: { title: [{ text: { content: item.title || "(Untitled Resource)" } }] },
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
                Summary: contentText
                  ? { rich_text: [{ text: { content: contentText.slice(0, 2000) } }] }
                  : undefined,
                "Last Synced": { date: { start: new Date().toISOString() } },
              };

              if (notionQuery.results.length > 0) {
                await notion.pages.update({
                  page_id: notionQuery.results[0].id,
                  properties: pageProps,
                });
                console.log(`♻️ Updated module item "${item.title}"`);
              } else {
                await notion.pages.create({
                  parent: { database_id: MODULE_CONTENT_DB_ID },
                  properties: {
                    ...pageProps,
                    "Auto-generated": { checkbox: true },
                  },
                });
                console.log(`✨ Created module item "${item.title}"`);
              }

              resourceCount++;
            } catch (err) {
              console.error(`❌ Module item failed: ${item.title} – ${err.message}`);
              await logSyncErrorToNotion(`Module item: ${item.title}`, err.message);
            }
          }
        }
      }
    } catch (err) {
      console.error(`❌ Resource sync error (${config.label}): ${err.message}`);
      await logSyncErrorToNotion(`Resource sync for ${config.label}`, err.message);
    }
  }

  res.send(`✅ Synced ${resourceCount} course resource items`);
});


          // ==============================
          // PART 3a.1 – Route Setup and Logging
          // ==============================
          app.get("/sync-due-check", async (req, res) => {
            res.send("✅ Sync started. Running in background...");
            console.log("🔍 Running due date + grade + status check...");
            let updatedCount = 0;

            for (const config of canvasConfigs) {
              try {
                const courses = await fetchAllPages(
                  `${config.baseUrl}/api/v1/courses`,
                  config.token
                );

          // ==============================
          // PART 3a.2 – Iterate Through Courses & Assignments
          // ==============================
                for (const course of courses) {
                  if (!course.name || !course.id || course.workflow_state !== "available") continue;

                  const assignments = await fetchAllPages(
                    `${config.baseUrl}/api/v1/courses/${course.id}/assignments?include[]=submission`,
                    config.token
                  );

                  const coursePageId = await findCoursePageId(course.name);
                  if (!coursePageId) continue;

          // ==============================
          // PART 3a.3 – Check Assignment Properties and Compare to Notion
          // ==============================
                  for (const assignment of assignments) {
                    try {
                      const notionQuery = await notion.databases.query({
                        database_id: NOTION_DB_ID,
                        filter: {
                          property: "Canvas Assignment ID",
                          rich_text: { equals: assignment.id.toString() },
                        },
                      });

                      if (!notionQuery.results.length) continue;

                      const page = notionQuery.results[0];
                      const props = page.properties;

                      const currentDue = props?.Due?.date?.start;
                      const currentStatus = props?.["Submission Status"]?.multi_select?.[0]?.name || null;
                      const currentGrade = props?.Grade?.rich_text?.[0]?.text?.content || null;
                      const currentPlotTwist = props?.["Plot Twist"]?.multi_select?.map((s) => s.name) || [];
                      const isAcknowledged = props?.Acknowledged?.checkbox || false;

                      const newDue = assignment.due_at;
                      const newStatus = detectSubmissionStatus(assignment, currentStatus);
                      const newGrade = buildGradeString(assignment.submission, assignment);
                      const closed = detectClosedStatus(assignment);

                      let updates = {};
                      let plotTwist = [...currentPlotTwist];

          // ==============================
          // PART 3a.4 – Update Conditions and Plot Twist Logic
          // ==============================
                      if (newDue && newDue !== currentDue) {
                        updates.Due = { date: { start: newDue } };
                        if (!isAcknowledged) plotTwist.push("⚡ Deadline Remix");
                      }

                      if (newStatus && newStatus !== currentStatus) {
                        updates["Submission Status"] = {
                          multi_select: [{ name: newStatus }],
                        };
                        if (!isAcknowledged) plotTwist.push("⚡ Deadline Remix");
                      }

                      if (newGrade && newGrade !== currentGrade) {
                        updates.Grade = {
                          rich_text: [{ text: { content: newGrade } }],
                        };
                        if (!isAcknowledged) plotTwist.push("⚡ Deadline Remix");
                      }

                      if (closed !== undefined) {
                        updates.Closed = {
                          select: { name: closed ? "Yes" : "No" },
                        };
                      }

                      updates["Last Synced"] = {
                        date: { start: new Date().toISOString() },
                      };

                      if (isAcknowledged) {
                        plotTwist = plotTwist.filter(
                          (tag) => tag !== "⚡ Deadline Remix" && tag !== "✨ Just Landed"
                        );
                      }

                      updates["Plot Twist"] = {
                        multi_select: [...new Set(plotTwist)].map((name) => ({ name })),
                      };

          // ==============================
          // PART 3a.5 – Push to Notion + Error Logging
          // ==============================
                      if (Object.keys(cleanUpdatedProps(updates)).length > 0) {
                        await notion.pages.update({
                          page_id: page.id,
                          properties: updates,
                        });
                        console.log(`🛠 Updated "${assignment.name}"`);
                        updatedCount++;
                      }
                    } catch (err) {
                      console.error(`❌ Update check failed for "${assignment.name}": ${err.message}`);
                      await logSyncErrorToNotion(`sync-due-check: ${assignment.name}`, err.message);
                    }
                  }
                }
              } catch (err) {
                console.error(`❌ Error syncing ${config.label}: ${err.message}`);
              }
            }
          });


// ==============================
// PART 3b – Helper: cleanUpdatedProps
// ==============================
function cleanUpdatedProps(updatedProps) {
  const cleaned = {};
  for (const [key, value] of Object.entries(updatedProps)) {
    if (value !== undefined && value !== null) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}
// ==============================
// PART 3c – Helper: buildGradeString
// ==============================
function buildGradeString(submission, assignment) {
  if (!submission || submission.score == null || assignment.points_possible == null) {
    return "Not Graded";
  }
  return `${submission.score} / ${assignment.points_possible}`;
}// ==============================
// PART 3d – Helper: detectClosedStatus
// ==============================
function detectClosedStatus(assignment) {
  return assignment?.closed_for_submissions ? "Yes" : "No";
}
// ==============================
// PART 4a – Welcome Route
// ==============================
app.get("/", (req, res) => {
  console.log("👋 Welcome route hit");

  const stats = getSystemStats();

  res.send(`
    ✅ Alive!<br>
    👋 Welcome to your Notion Class Importer!<br>
    💾 RAM: ${stats.usedMemory} used of ${stats.totalMemory}<br>
    ⏱️ Uptime: ${stats.uptime}
  `);
});

// ==============================
// PART 4b – Canvas API Test Route
// ==============================
app.get("/test-canvas", async (req, res) => {
  console.log("🧪 Test-canvas route hit");
  try {
    const response = await fetch(`${canvasConfigs[0].baseUrl}/api/v1/courses`, {
      headers: { Authorization: `Bearer ${canvasConfigs[0].token}` },
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error(`❌ Error on test-canvas route: ${error.message}`);
    res.status(500).send(`Error: ${error.message}`);
  }
});
// ==============================
// PART 4c – Start Server (DO NOT REMOVE)
// ==============================
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("🔐 Environment Variables:");
  console.log({
    NOTION_API_TOKEN: !!process.env.NOTION_API_TOKEN,
    NOTION_DB_ID: !!process.env.NOTION_DB_ID,
    COURSE_PLANNER_DB: !!process.env.COURSE_PLANNER_DB,
    NOTION_COURSE_RESOURCE_DB_ID: !!process.env.NOTION_COURSE_RESOURCE_DB_ID,
    ERROR_LOG_DB_ID: !!process.env.ERROR_LOG_DB_ID,
    CANVAS_1_API_TOKEN: !!process.env.CANVAS_1_API_TOKEN,
    CANVAS_1_API_BASE: process.env.CANVAS_1_API_BASE,
    CANVAS_1_LABEL: !!process.env.CANVAS_1_LABEL,
    CANVAS_2_API_TOKEN: !!process.env.CANVAS_2_API_TOKEN,
    CANVAS_2_API_BASE: process.env.CANVAS_2_API_BASE,
    CANVAS_2_LABEL: !!process.env.CANVAS_2_LABEL,
  });

  const stats = getSystemStats();
  console.log(`🧠 RAM Usage: ${stats.memory}`);
  console.log(`⏳ Uptime: ${stats.uptime}`);
});
